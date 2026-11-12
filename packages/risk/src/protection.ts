// Protective stops executed by CODE, not by the AI. Parameter names come from preset.protection,
// so a new preset gets stops without any code change.
import type { GenericParams, PresetInfo } from "@glint/strategy";

export interface Position {
  market: string;
  qty: number;
  entryPx: number | null; // average entry price
}

export type ProtectKind = "stop_loss" | "take_profit" | "trailing";

export interface ProtectTrigger {
  market: string;
  kind: ProtectKind;
  triggerPx: number;
  mid: number;
  reason: string;
}

function pctParam(params: GenericParams, key: string | undefined): number | null {
  if (!key) return null;
  const v = params[key];
  return typeof v === "number" && v > 0 && Number.isFinite(v) ? v : null;
}

export interface ProtectLevels {
  stopPx: number | null;
  takePx: number | null;
  trailPx: number | null;
}

export function protectLevels(preset: Pick<PresetInfo, "protection">, params: GenericParams, pos: Position, peak: number | undefined): ProtectLevels {
  const p = preset.protection ?? {};
  const sl = pctParam(params, p.stopLossParam);
  const tp = pctParam(params, p.takeProfitParam);
  const tr = pctParam(params, p.trailingParam);
  const entry = pos.entryPx && pos.entryPx > 0 ? pos.entryPx : null;
  return {
    stopPx: sl !== null && entry ? entry * (1 - sl / 100) : null,
    takePx: tp !== null && entry ? entry * (1 + tp / 100) : null,
    trailPx: tr !== null && peak && peak > 0 ? peak * (1 - tr / 100) : null,
  };
}

/** Positions that must be closed right now. Priority: stop-loss, then trailing stop, then take-profit. */
export function checkProtection(
  preset: Pick<PresetInfo, "protection" | "allowsSell">,
  params: GenericParams,
  positions: Position[],
  mids: Record<string, number>,
  peaks: Record<string, number> = {},
): ProtectTrigger[] {
  if (!preset.allowsSell || !preset.protection) return [];
  const out: ProtectTrigger[] = [];
  for (const pos of positions) {
    const mid = mids[pos.market];
    if (!(pos.qty > 0) || !(mid > 0)) continue;
    const lv = protectLevels(preset, params, pos, peaks[pos.market]);
    const fmt = (x: number) => Number(x.toPrecision(6));
    if (lv.stopPx !== null && mid <= lv.stopPx) {
      out.push({
        market: pos.market,
        kind: "stop_loss",
        triggerPx: lv.stopPx,
        mid,
        reason: `Stop-loss: price ${fmt(mid)} <= ${fmt(lv.stopPx)} (entry ${fmt(pos.entryPx!)})`,
      });
    } else if (lv.trailPx !== null && mid <= lv.trailPx) {
      out.push({
        market: pos.market,
        kind: "trailing",
        triggerPx: lv.trailPx,
        mid,
        reason: `Trailing stop: price ${fmt(mid)} <= ${fmt(lv.trailPx)} (peak ${fmt(peaks[pos.market])})`,
      });
    } else if (lv.takePx !== null && mid >= lv.takePx) {
      out.push({
        market: pos.market,
        kind: "take_profit",
        triggerPx: lv.takePx,
        mid,
        reason: `Take-profit: price ${fmt(mid)} >= ${fmt(lv.takePx)} (entry ${fmt(pos.entryPx!)})`,
      });
    }
  }
  return out;
}

/** Whether any position is within nearPct percent of a stop/take level (a cheap trigger for an AI decision). */
export function nearProtection(
  preset: Pick<PresetInfo, "protection" | "allowsSell">,
  params: GenericParams,
  positions: Position[],
  mids: Record<string, number>,
  peaks: Record<string, number> = {},
  nearPct = 1,
): boolean {
  if (!preset.protection) return false;
  for (const pos of positions) {
    const mid = mids[pos.market];
    if (!(pos.qty > 0) || !(mid > 0)) continue;
    const lv = protectLevels(preset, params, pos, peaks[pos.market]);
    for (const lvl of [lv.stopPx, lv.takePx, lv.trailPx]) {
      if (lvl !== null && Math.abs(mid - lvl) / mid <= nearPct / 100) return true;
    }
  }
  return false;
}

/** Updates price peaks for open positions (for trailing stops); closed positions are dropped. */
export function updatePeaks(peaks: Record<string, number>, positions: Position[], mids: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pos of positions) {
    const mid = mids[pos.market];
    if (!(pos.qty > 0) || !(mid > 0)) continue;
    out[pos.market] = Math.max(peaks[pos.market] ?? mid, mid);
  }
  return out;
}

/** Average entry price from the trade history (average cost method). null when the position from history is zero. */
export function avgEntryFromTrades(
  trades: { side: "buy" | "sell"; market: string; sizeBase: number; price: number }[],
  market: string,
): { qty: number; avgPx: number | null } {
  let qty = 0;
  let cost = 0;
  for (const t of trades) {
    if (t.market !== market || !(t.sizeBase > 0)) continue;
    if (t.side === "buy") {
      qty += t.sizeBase;
      cost += t.sizeBase * t.price;
    } else if (qty > 0) {
      const sold = Math.min(t.sizeBase, qty);
      cost -= (cost / qty) * sold;
      qty -= sold;
      if (qty < 1e-12) {
        qty = 0;
        cost = 0;
      }
    }
  }
  return { qty, avgPx: qty > 0 ? cost / qty : null };
}
