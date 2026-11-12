// Markets = all Lighter RH spot pairs quoted in USDG (orderBookDetails.spot_order_book_details).
// Market symbol = base asset (NVDA, SPY, ETH, ...); coin = the pair ("NVDA/USDG"); hlSpotIndex = market_id.
//
// Sessions / halts of tokenized stocks (checked 2026-11-11): the docs document no trading hours for RH spot pairs
// and the candles show trading 24/7 including weekends. What the API exposes is the market `status`
// ("active" | "inactive" | "in-settlement" | "waiting-for-settlement" | "settled"; only "active" is tradeable),
// `is_frozen` and an optional start/end window. A market is OPEN when status = active, not frozen and inside the
// window. Corporate actions are handled by Lighter by delisting/settling the market (docs: corporate-actions), which
// shows up as a status change. The runner skips buys on closed markets and tells the AI which markets are closed.
import type { MarketInfo, MarketTier } from "@glint/strategy";
import type { ExchangeSpotMarket } from "./types.js";

/** A market as the platform keeps it: the public MarketInfo plus the exchange fields the runner needs. */
export interface ResolvedMarket extends MarketInfo {
  coin: string; // Lighter pair symbol, the key for market data: "NVDA/USDG"
  resolved: boolean; // listed in orderBookDetails (spot)
  markPx?: number;
  prevDayPx?: number;
  isCanonical?: boolean;
  isFrozen?: boolean;
  minBaseAmount?: number;
  startTs?: number; // ms, 0 = none
  endTs?: number; // ms, 0 = none
}

/** A market from orderBookDetails, ready to sync into the platform's market list (which owns `enabled`). */
export type SyncedMarket = Omit<ResolvedMarket, "enabled" | "lastSyncAt" | "tier">;

export const QUOTE = "USDG";

/** Spot pairs to USDG, sorted by 24h volume (descending). */
export function parseSpotUsdgMarkets(rows: ExchangeSpotMarket[]): SyncedMarket[] {
  const best = new Map<string, SyncedMarket>();
  for (const r of rows) {
    if (r.quote !== QUOTE || !r.base) continue;
    const prevDay = r.lastPrice > 0 && Number.isFinite(r.dayPriceChangePct) && r.dayPriceChangePct > -100 ? r.lastPrice / (1 + r.dayPriceChangePct / 100) : 0;
    const m: SyncedMarket = {
      symbol: r.base,
      pair: r.pair,
      hlSpotIndex: r.marketId,
      marketId: r.marketId,
      szDecimals: r.szDecimals,
      priceDecimals: r.priceDecimals,
      coin: r.pair,
      resolved: true,
      dayVolumeUsd: r.dayQuoteVolume,
      midUsd: r.lastPrice,
      markPx: r.lastPrice,
      prevDayPx: prevDay,
      isCanonical: true,
      status: r.status,
      isFrozen: r.isFrozen,
      minBaseAmount: r.minBaseAmount,
      startTs: r.startTimestamp,
      endTs: r.endTimestamp,
    };
    // one pair per base symbol: keep the active one, then the larger volume
    const prev = best.get(m.symbol);
    const score = (x: SyncedMarket) => (x.status === "active" ? 1e15 : 0) + (x.dayVolumeUsd ?? 0);
    if (!prev || score(m) > score(prev)) best.set(m.symbol, m);
  }
  return [...best.values()].sort((a, b) => (b.dayVolumeUsd ?? 0) - (a.dayVolumeUsd ?? 0) || a.symbol.localeCompare(b.symbol));
}

export interface MarketOpenState {
  open: boolean;
  reason?: string;
}

/** Is the market open for trading now (ms)? */
export function marketOpenState(m: Pick<ResolvedMarket, "status" | "isFrozen" | "startTs" | "endTs" | "resolved">, nowMs: number): MarketOpenState {
  if (m.resolved === false) return { open: false, reason: "delisted" };
  const status = m.status ?? "active";
  if (status !== "active") return { open: false, reason: `status:${status}` };
  if (m.isFrozen) return { open: false, reason: "frozen" };
  if (m.startTs && m.startTs > 0 && nowMs < m.startTs) return { open: false, reason: "not_started" };
  if (m.endTs && m.endTs > 0 && nowMs >= m.endTs) return { open: false, reason: "ended" };
  return { open: true };
}

export interface TierThresholds {
  minMarketDayVolumeUsd: number;
  liquidDayVolumeUsd: number;
}

export function marketTier(dayVolumeUsd: number | undefined, t: TierThresholds): MarketTier {
  const v = dayVolumeUsd ?? 0;
  if (v >= t.liquidDayVolumeUsd) return "liquid";
  if (v >= t.minMarketDayVolumeUsd) return "thin";
  return "illiquid";
}

/** For the API: market with tier and open state. */
export function withTier(m: ResolvedMarket, t: TierThresholds, nowMs = Date.now()): ResolvedMarket {
  const st = marketOpenState(m, nowMs);
  return { ...m, tier: marketTier(m.dayVolumeUsd, t), open: st.open, ...(st.reason ? { closedReason: st.reason } : {}) };
}
