// Liquidity guard: spread, book impact, share of 24h volume, minimum volume, limit-price cap, clip mode for stops.

import type { OrderBook } from "@glint/lighter";
import { describe, expect, it } from "vitest";
import { checkLiquidity, type LiquidityLimits } from "../src/index.js";

const L: LiquidityLimits = {
  maxSpreadBps: 150,
  maxSlippageBps: 100,
  maxOrderPctOfDayVolume: 2,
  minMarketDayVolumeUsd: 5000,
  minOrderUsd: 10,
  bookBufferBps: 10,
};
const VOL = 1_000_000;

/** Book around mid = 100: level step stepBps, size sz per level. */
function book(mid = 100, halfSpreadBps = 5, stepBps = 5, sz = 10, levels = 20): OrderBook {
  const bids = Array.from({ length: levels }, (_, i) => ({ px: mid * (1 - (halfSpreadBps + i * stepBps) / 10000), sz }));
  const asks = Array.from({ length: levels }, (_, i) => ({ px: mid * (1 + (halfSpreadBps + i * stepBps) / 10000), sz }));
  return { bids, asks };
}

describe("checkLiquidity: strict (AI orders)", () => {
  it("ok: the size fills on the first levels; limit = worst level + buffer, never beyond the band", () => {
    const r = checkLiquidity({ side: "buy", sizeBase: 15, limitPx: 101, szDecimals: 2 }, book(), VOL, L);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // levels 100.05 (10) and 100.10 (5) -> worst 100.10; +10 bps -> 100.2001 -> down to 5 significant figures = 100.2
    expect(r.limitPx).toBe("100.2");
    expect(r.sizeBase).toBe("15");
    expect(r.clipped).toBe(false);
    expect(r.spreadBps).toBeCloseTo(10, 6);
    expect(r.impactBps).toBeCloseTo(10, 6);
    expect(r.avgPx).toBeCloseTo((10 * 100.05 + 5 * 100.1) / 15, 9);
    expect(Number(r.limitPx)).toBeLessThanOrEqual(101); // never above the risk-engine limit
  });

  it("a sell walks the bids down; the limit never goes below the band", () => {
    const r = checkLiquidity({ side: "sell", sizeBase: 25, limitPx: 99, szDecimals: 2 }, book(), VOL, L);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.limitPx)).toBeGreaterThanOrEqual(99);
    expect(Number(r.limitPx)).toBeLessThanOrEqual(99.85);
  });

  it("spread_too_wide: 200 bps spread > 150", () => {
    const r = checkLiquidity({ side: "buy", sizeBase: 1, limitPx: 102, szDecimals: 2 }, book(100, 100), VOL, L);
    expect(r).toMatchObject({ ok: false, code: "spread_too_wide" });
  });

  it("price_impact_too_high: not enough size within the 100 bps band even though the book has more", () => {
    // 20 levels of 1 unit, 10 bps step: within +100 bps there are 10 levels = 10 units, 15 needed
    const r = checkLiquidity({ side: "buy", sizeBase: 15, limitPx: 101, szDecimals: 2 }, book(100, 5, 10, 1), VOL, L);
    expect(r).toMatchObject({ ok: false, code: "price_impact_too_high" });
    if (!r.ok) expect(r.depthInBandBase).toBe(10);
  });

  it("insufficient_depth: the whole book is smaller than the order", () => {
    const r = checkLiquidity({ side: "buy", sizeBase: 50, limitPx: 101, szDecimals: 2 }, book(100, 5, 5, 1, 5), VOL, L);
    expect(r).toMatchObject({ ok: false, code: "insufficient_depth" });
  });

  it("a risk-engine limit tighter than the band bounds the book walk", () => {
    // limit 100.06 only reaches the first level (100.05 x 10): 15 cannot fill
    const r = checkLiquidity({ side: "buy", sizeBase: 15, limitPx: 100.06, szDecimals: 2 }, book(), VOL, L);
    expect(r).toMatchObject({ ok: false, code: "price_impact_too_high" });
  });

  it("order_too_large_for_volume: order > 2% of 24h volume", () => {
    // 24h volume 10,000 USD -> cap 200 USD; order 3 x 100 = 300 USD
    const r = checkLiquidity({ side: "buy", sizeBase: 3, limitPx: 101, szDecimals: 2 }, book(), 10_000, L);
    expect(r).toMatchObject({ ok: false, code: "order_too_large_for_volume" });
    const ok = checkLiquidity({ side: "buy", sizeBase: 1.5, limitPx: 101, szDecimals: 2 }, book(), 10_000, L);
    expect(ok.ok).toBe(true);
  });

  it("illiquid_market: 24h volume below the minimum", () => {
    const r = checkLiquidity({ side: "buy", sizeBase: 1, limitPx: 101, szDecimals: 2 }, book(), 4999, L);
    expect(r).toMatchObject({ ok: false, code: "illiquid_market" });
  });

  it("no_book: empty or crossed book", () => {
    expect(checkLiquidity({ side: "buy", sizeBase: 1, limitPx: 101, szDecimals: 2 }, { bids: [], asks: [] }, VOL, L)).toMatchObject({
      ok: false,
      code: "no_book",
    });
    const crossed = { bids: [{ px: 101, sz: 1 }], asks: [{ px: 100, sz: 1 }] };
    expect(checkLiquidity({ side: "buy", sizeBase: 1, limitPx: 101, szDecimals: 2 }, crossed, VOL, L)).toMatchObject({ ok: false, code: "no_book" });
  });

  it("an unordered book is normalized; zero or broken levels are ignored", () => {
    const b = book();
    const messy: OrderBook = { bids: [...b.bids].reverse().concat({ px: 0, sz: 5 }), asks: [...b.asks].reverse().concat({ px: Number.NaN, sz: 1 }) };
    const r = checkLiquidity({ side: "buy", sizeBase: 15, limitPx: 101, szDecimals: 2 }, messy, VOL, L);
    expect(r).toMatchObject({ ok: true, limitPx: "100.2" });
  });

  it("below_min_order: under 10 USD after rounding the size to szDecimals", () => {
    const r = checkLiquidity({ side: "buy", sizeBase: 0.05, limitPx: 101, szDecimals: 2 }, book(), VOL, L);
    expect(r).toMatchObject({ ok: false, code: "below_min_order" });
  });
});

describe("checkLiquidity: clip (protective sells by code)", () => {
  it("a wide spread and low volume never block an exit; the size is clipped to what fills within the band", () => {
    // 120 bps spread (half 60), 10 bps step, 1 unit each: within -100 bps of mid only 99.4..99.0 -> 5 units
    const r = checkLiquidity({ side: "sell", sizeBase: 50, limitPx: 99, szDecimals: 2 }, book(100, 60, 10, 1), 100, L, "clip");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clipped).toBe(true);
    expect(r.sizeBase).toBe("5");
    expect(Number(r.limitPx)).toBeGreaterThanOrEqual(99);
  });

  it("clip with no liquidity in the band: insufficient_depth", () => {
    const r = checkLiquidity({ side: "sell", sizeBase: 5, limitPx: 99, szDecimals: 2 }, book(100, 200, 10, 1), VOL, L, "clip");
    expect(r).toMatchObject({ ok: false, code: "insufficient_depth" });
  });
});
