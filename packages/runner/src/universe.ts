// The agent's market set for one tick (its "universe"): pure functions, no network.
//  - selected pairs: markets from spec.markets (disabled ones stay, so a position can still be sold); buys only on enabled;
//  - "*" mode (all liquid pairs): held positions plus a shortlist of N candidates among enabled markets,
//    ranked by 24h volume and 24h price move (generic momentum/volatility, no preset logic).
// A bounded shortlist keeps the prompt size and AI cost constant with hundreds of pairs.
import type { ResolvedMarket } from "@glint/lighter";
import { isAllMarkets, MIN_ORDER_MARGIN } from "@glint/strategy";

export interface UniverseMarket extends ResolvedMarket {
  /** Whether buying is allowed: enabled by the platform and part of the agent's set. Selling a position is always allowed. */
  buyable: boolean;
  /** Why buying is not allowed (for a clear risk engine rejection); "closed" = the market is closed or halted on Lighter. */
  unbuyableReason?: "disabled" | "min_order" | "closed";
}

/** "Has a position" threshold: token value >= this many USD (dust does not count). */
export const POSITION_DUST_USD = 1;

/** Symbols of held positions (value >= dustUsd). */
export function heldSymbols(tokens: Record<string, number>, mids: Record<string, number>, dustUsd = POSITION_DUST_USD): string[] {
  return Object.entries(tokens)
    .filter(([sym, q]) => sym !== "USDG" && sym !== "USDC" && q > 0 && q * (mids[sym] ?? 0) >= dustUsd)
    .map(([sym]) => sym);
}

/**
 * Candidate shortlist: enabled markets (except `exclude`), score = 0.7 * normalized log volume + 0.3 * normalized |24h change|.
 * Deterministic: ties break on volume, then symbol.
 */
export function buildShortlist(candidates: ResolvedMarket[], exclude: Set<string>, n: number): ResolvedMarket[] {
  const pool = candidates.filter((m) => m.resolved && m.enabled && !exclude.has(m.symbol));
  if (pool.length === 0 || n <= 0) return [];
  const logVol = (m: ResolvedMarket) => Math.log10(1 + Math.max(0, m.dayVolumeUsd ?? 0));
  const move = (m: ResolvedMarket) => Math.abs(m.change24hPct ?? 0);
  const maxLog = Math.max(1e-9, ...pool.map(logVol));
  const maxMove = Math.max(1e-9, ...pool.map(move));
  return pool
    .map((m) => ({ m, score: 0.7 * (logVol(m) / maxLog) + 0.3 * (move(m) / maxMove) }))
    .sort((a, b) => b.score - a.score || (b.m.dayVolumeUsd ?? 0) - (a.m.dayVolumeUsd ?? 0) || a.m.symbol.localeCompare(b.m.symbol))
    .slice(0, n)
    .map((x) => x.m);
}

/**
 * Whether a minimum order can be bought at all: the max buy (maxBuyUsd) rounded down to the lot step (10^-szDecimals)
 * must be >= minOrderUsd (with the MIN_ORDER_MARGIN headroom). Example: a token at ~$612 with szDecimals 2 has a $6.12 lot; with an $11.7 budget that is
 * 0.01 = $6.12 < $10, so it cannot be bought even though the budget exceeds the minimum.
 */
export function affordableBuy(szDecimals: number, mid: number | undefined, maxBuyUsd: number, minOrderUsd: number): boolean {
  if (!(mid && mid > 0) || !(maxBuyUsd > 0)) return false;
  const lot = 10 ** -szDecimals;
  const lots = Math.floor(maxBuyUsd / mid / lot + 1e-9);
  return lots * lot * mid >= minOrderUsd * MIN_ORDER_MARGIN;
}

/**
 * Minimum share of a position (bps) to sell so that, after rounding down to the lot step and filling below mid
 * (bid + slippage, MIN_ORDER_MARGIN headroom), the order is >= minOrderUsd. > 10000 means the whole position cannot be sold.
 */
export function minSellShareBps(qty: number, mid: number, szDecimals: number, minOrderUsd: number): number {
  if (!(qty > 0) || !(mid > 0)) return Infinity;
  const lot = 10 ** -szDecimals;
  const minLots = Math.ceil((minOrderUsd * MIN_ORDER_MARGIN) / (lot * mid));
  return Math.ceil(((minLots * lot) / qty) * 10000);
}

/**
 * The agent's markets for this tick.
 * @param all - every known market (any enabled state); only resolved ones participate
 * @param held - symbols of held positions (heldSymbols)
 * @param canBuy - optional "capital/lot allows a minimum order" filter. In "*" mode such pairs are left out of the
 *   shortlist (buyable ones take their place); with selected pairs they stay, but buyable=false.
 * @param isOpen - optional "the market is open on the exchange" check (Lighter status active, not frozen, inside its
 *   window). Closed markets are left out of the "*" shortlist; selected or held ones stay with buyable=false.
 */
export function agentUniverse(
  specMarkets: string[],
  all: ResolvedMarket[],
  held: string[],
  shortlistN: number,
  canBuy: (m: ResolvedMarket) => boolean = () => true,
  isOpen: (m: ResolvedMarket) => boolean = () => true,
): UniverseMarket[] {
  const bySymbol = new Map(all.filter((m) => m.resolved).map((m) => [m.symbol, m]));
  const out = new Map<string, UniverseMarket>();
  if (isAllMarkets(specMarkets)) {
    for (const s of held) {
      const m = bySymbol.get(s);
      if (m) out.set(s, withBuyable(m, canBuy, isOpen));
    }
    const candidates = [...bySymbol.values()].filter((m) => canBuy(m) && isOpen(m));
    for (const m of buildShortlist(candidates, new Set(out.keys()), shortlistN)) out.set(m.symbol, { ...m, buyable: true });
  } else {
    for (const s of specMarkets) {
      const m = bySymbol.get(s);
      if (m) out.set(s, withBuyable(m, canBuy, isOpen));
    }
  }
  return [...out.values()];
}

function withBuyable(m: ResolvedMarket, canBuy: (m: ResolvedMarket) => boolean, isOpen: (m: ResolvedMarket) => boolean): UniverseMarket {
  if (!m.enabled) return { ...m, buyable: false, unbuyableReason: "disabled" };
  if (!isOpen(m)) return { ...m, buyable: false, unbuyableReason: "closed" };
  if (!canBuy(m)) return { ...m, buyable: false, unbuyableReason: "min_order" };
  return { ...m, buyable: true };
}
