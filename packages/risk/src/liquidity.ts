// Liquidity guard: a deterministic pure function applied to EVERY order after evaluateDecision.
// Input: the order (side, size, risk-engine limit), the L2 book at execution time, the market's 24h volume, thresholds.
// Checks (strict mode, AI orders):
//   1) 24h volume >= minMarketDayVolumeUsd                        -> illiquid_market
//   2) both sides of the book are non-empty                       -> no_book
//   3) spread <= maxSpreadBps                                     -> spread_too_wide
//   4) notional <= maxOrderPctOfDayVolume % of 24h volume         -> order_too_large_for_volume
//   5) book walk: the whole size fills within the band
//      min(mid +/- maxSlippageBps, risk-engine limit)            -> price_impact_too_high / insufficient_depth
// The order limit is tightened to the book walk: the worst level touched plus a small buffer
// (bookBufferBps for book movement within milliseconds), never beyond the band.
// Clip mode (protective sells by code): checks 1, 3 and 4 never block an exit; the size is clipped to what can
// actually fill within the slippage band (a stop never sells into a void, and is never cancelled outright).
import { type BookLevel, formatSpotPrice, formatSpotSize, type OrderBook } from "@glint/lighter";

export interface LiquidityLimits {
  maxSpreadBps: number;
  maxSlippageBps: number;
  maxOrderPctOfDayVolume: number; // percent, 2 = 2%
  minMarketDayVolumeUsd: number;
  minOrderUsd: number;
  bookBufferBps?: number; // default 10
}

export type LiquidityRejectCode =
  | "illiquid_market"
  | "no_book"
  | "spread_too_wide"
  | "order_too_large_for_volume"
  | "insufficient_depth"
  | "price_impact_too_high"
  | "below_min_order";

export interface LiquidityOrder {
  side: "buy" | "sell";
  sizeBase: number;
  limitPx: number; // limit produced by the risk engine
  szDecimals: number;
  priceDecimals?: number; // default 2
}

export interface LiquidityMetrics {
  midPx: number;
  spreadBps: number;
  impactBps: number; // worst level touched relative to mid
  avgPx: number;
  depthInBandBase: number; // base size available within the band
}

export type LiquidityResult =
  | ({ ok: true; sizeBase: string; limitPx: string; notionalUsd: number; clipped: boolean } & LiquidityMetrics)
  | ({ ok: false; code: LiquidityRejectCode; message: string } & Partial<LiquidityMetrics>);

const bpsOf = (a: number, b: number) => (Math.abs(a - b) / b) * 10000;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Normalizes levels: positive values only, correct ordering. */
export function normalizeBook(book: OrderBook): OrderBook {
  const clean = (lv: BookLevel[]) => lv.filter((l) => Number.isFinite(l.px) && Number.isFinite(l.sz) && l.px > 0 && l.sz > 0);
  return {
    bids: clean(book.bids).sort((a, b) => b.px - a.px),
    asks: clean(book.asks).sort((a, b) => a.px - b.px),
    time: book.time,
  };
}

export function checkLiquidity(
  order: LiquidityOrder,
  rawBook: OrderBook,
  dayVolumeUsd: number,
  limits: LiquidityLimits,
  mode: "strict" | "clip" = "strict",
): LiquidityResult {
  const strict = mode === "strict";
  if (!(order.sizeBase > 0)) return { ok: false, code: "below_min_order", message: "order size is zero" };

  if (strict && !(dayVolumeUsd >= limits.minMarketDayVolumeUsd))
    return {
      ok: false,
      code: "illiquid_market",
      message: `24h volume ${Math.round(dayVolumeUsd)} USD is below the ${limits.minMarketDayVolumeUsd} USD minimum`,
    };

  const book = normalizeBook(rawBook);
  const bestBid = book.bids[0]?.px;
  const bestAsk = book.asks[0]?.px;
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk <= bestBid) return { ok: false, code: "no_book", message: "order book is empty or crossed" };
  const midPx = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / midPx) * 10000;
  if (strict && spreadBps > limits.maxSpreadBps)
    return { ok: false, code: "spread_too_wide", message: `spread ${r1(spreadBps)} bps > ${limits.maxSpreadBps} bps`, midPx, spreadBps };

  const estNotional = order.sizeBase * midPx;
  const volCap = (dayVolumeUsd * limits.maxOrderPctOfDayVolume) / 100;
  if (strict && estNotional > volCap)
    return {
      ok: false,
      code: "order_too_large_for_volume",
      message: `order ${estNotional.toFixed(2)} USD > ${limits.maxOrderPctOfDayVolume}% of 24h volume (${volCap.toFixed(2)} USD)`,
      midPx,
      spreadBps,
    };

  // band: no further than maxSlippageBps from the book mid and no further than the risk-engine limit
  const isBuy = order.side === "buy";
  const bandPx = isBuy ? midPx * (1 + limits.maxSlippageBps / 10000) : midPx * (1 - limits.maxSlippageBps / 10000);
  const capPx = isBuy ? Math.min(bandPx, order.limitPx) : Math.max(bandPx, order.limitPx);
  const levels = isBuy ? book.asks : book.bids;
  const inBand = (px: number) => (isBuy ? px <= capPx + 1e-12 : px >= capPx - 1e-12);

  let need = order.sizeBase;
  let got = 0;
  let cost = 0;
  let worst = levels[0].px;
  let depthInBand = 0;
  let totalDepth = 0;
  for (const l of levels) {
    totalDepth += l.sz;
    if (!inBand(l.px)) continue;
    depthInBand += l.sz;
    if (need > 0) {
      const take = Math.min(need, l.sz);
      got += take;
      cost += take * l.px;
      need -= take;
      worst = l.px;
    }
  }

  let clipped = false;
  let qtyStr: string;
  if (need > 1e-12) {
    if (strict) {
      const impactAll = bpsOf(levels[levels.length - 1].px, midPx);
      if (totalDepth + 1e-12 < order.sizeBase)
        return {
          ok: false,
          code: "insufficient_depth",
          message: `book depth ${totalDepth} < order size ${order.sizeBase}`,
          midPx,
          spreadBps,
          depthInBandBase: depthInBand,
        };
      return {
        ok: false,
        code: "price_impact_too_high",
        message: `filling ${order.sizeBase} needs price impact beyond ${limits.maxSlippageBps} bps (only ${depthInBand} available within the band)`,
        midPx,
        spreadBps,
        impactBps: impactAll,
        depthInBandBase: depthInBand,
      };
    }
    clipped = true;
    qtyStr = formatSpotSize(got, order.szDecimals);
  } else {
    qtyStr = formatSpotSize(order.sizeBase, order.szDecimals);
  }
  const qty = Number(qtyStr);
  if (!(qty > 0))
    return { ok: false, code: "insufficient_depth", message: "no liquidity within the slippage band", midPx, spreadBps, depthInBandBase: depthInBand };
  const avgPx = got > 0 ? cost / got : worst;

  // limit: worst level + buffer, never beyond the band; rounded in the safe direction
  const buf = (limits.bookBufferBps ?? 10) / 10000;
  const rawLimit = isBuy ? Math.min(capPx, worst * (1 + buf)) : Math.max(capPx, worst * (1 - buf));
  const pxDec = order.priceDecimals ?? 2;
  let limitPx = formatSpotPrice(rawLimit, pxDec, isBuy ? "down" : "up");

  if (isBuy ? Number(limitPx) < worst : Number(limitPx) > worst) limitPx = formatSpotPrice(worst, pxDec, "nearest");

  const notionalUsd = qty * avgPx;
  if (notionalUsd < limits.minOrderUsd)
    return {
      ok: false,
      code: "below_min_order",
      message: `fillable size ${notionalUsd.toFixed(2)} USD is below the ${limits.minOrderUsd} USD minimum`,
      midPx,
      spreadBps,
      depthInBandBase: depthInBand,
    };

  return { ok: true, sizeBase: qtyStr, limitPx, notionalUsd, clipped, midPx, spreadBps, impactBps: bpsOf(worst, midPx), avgPx, depthInBandBase: depthInBand };
}
