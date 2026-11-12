// Preset rules enforced by code (PresetInfo.rules): pure functions, no preset-specific logic.

import { indicatorLabel, resolveIndicatorSpecs } from "@glint/indicators";
import type { GenericParams, IndicatorCondition, IndicatorSpec, PresetInfo, RuleOperand } from "@glint/strategy";

/** Preset indicator labels by index (after agent params override periods/timeframe). */
export function indicatorLabels(indicators: IndicatorSpec[], params: GenericParams): string[] {
  return resolveIndicatorSpecs(indicators, params).map(indicatorLabel);
}

/** Indicator values by index from a label -> value record. */
export function indicatorValues(labels: string[], byLabel: Record<string, number | null> | undefined): (number | null)[] {
  return labels.map((l) => (byLabel && typeof byLabel[l] === "number" && Number.isFinite(byLabel[l]!) ? (byLabel[l] as number) : null));
}

function operand(o: RuleOperand, values: (number | null)[], mid: number, params?: GenericParams): number | null {
  if ("ind" in o) return values[o.ind] ?? null;
  if ("price" in o) return mid > 0 ? mid : null;
  if ("param" in o) return numParam(params, o.param) ?? null;
  return Number.isFinite(o.value) ? o.value : null;
}

/**
 * true: every condition holds; false: some condition fails; null: data is missing (an indicator could not be
 * computed or a numeric agent param is absent).
 */
export function evalConditions(
  conds: IndicatorCondition[] | undefined,
  values: (number | null)[] | undefined,
  mid: number,
  params?: GenericParams,
): boolean | null {
  if (!conds || conds.length === 0) return true;
  let missing = false;
  for (const c of conds) {
    const l = operand(c.left, values ?? [], mid, params);
    const r = operand(c.right, values ?? [], mid, params);
    if (l === null || r === null) {
      missing = true;
      continue;
    }
    const ok = c.op === ">" ? l > r : c.op === "<" ? l < r : c.op === ">=" ? l >= r : l <= r;
    if (!ok) return false;
  }
  return missing ? null : true;
}

export function describeConditions(conds: IndicatorCondition[], labels: string[], params?: GenericParams): string {
  const op = (o: RuleOperand) =>
    "ind" in o
      ? (labels[o.ind] ?? `#${o.ind}`)
      : "price" in o
        ? "price"
        : "param" in o
          ? `${o.param}${params && numParam(params, o.param) !== undefined ? `(${numParam(params, o.param)})` : ""}`
          : String(o.value);
  return conds.map((c) => `${op(c.left)} ${c.op} ${op(c.right)}`).join(" and ");
}

/** Rebalance target weights from params[name] = { SYMBOL: bps }: positive integers only. */
export function weightsParam(params: GenericParams | undefined, name: string | undefined): Record<string, number> | undefined {
  if (!name || !params) return undefined;
  const v = params[name];
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, number>)) if (typeof x === "number" && Number.isFinite(x) && x > 0) out[k] = Math.floor(x);
  return out;
}

export interface RebalanceInput {
  targets: Record<string, number>; // bps of equity
  bandBps: number;
  equity: number;
  balances: { usdc: number; tokens: Record<string, number> };
  mids: Record<string, number>;
  /** Markets that can be bought right now (enabled, liquid). */
  buyable: (symbol: string) => boolean;
}

/**
 * Rebalance plan (code, not AI): for every token whose share drifts from its target by more than the band, an action
 * that brings it back. Tokens without a target (0) are sold entirely. Sells first (they free USDG), then buys.
 * buy.sizeBps is a share of equity; sell.sizeBps is a share of the current position (as in AgentAction).
 */
export function rebalancePlan(i: RebalanceInput): { market: string; type: "buy" | "sell"; sizeBps: number; currentBps: number; targetBps: number }[] {
  if (!(i.equity > 0)) return [];
  const syms = new Set([...Object.keys(i.targets), ...Object.keys(i.balances.tokens).filter((s) => (i.balances.tokens[s] ?? 0) > 0)]);
  const sells: ReturnType<typeof rebalancePlan> = [];
  const buys: ReturnType<typeof rebalancePlan> = [];
  for (const s of syms) {
    const mid = i.mids[s];
    if (!(mid > 0)) continue;
    const q = i.balances.tokens[s] ?? 0;
    const cur = ((q * mid) / i.equity) * 10000;
    const tgt = i.targets[s] ?? 0;
    const diff = cur - tgt;
    if (Math.abs(diff) <= i.bandBps) continue;
    if (diff > 0 && q > 0) {
      const sizeBps = tgt === 0 ? 10000 : Math.max(1, Math.min(10000, Math.floor((diff / cur) * 10000)));
      sells.push({ market: s, type: "sell", sizeBps, currentBps: Math.round(cur), targetBps: tgt });
    } else if (diff < 0 && i.buyable(s)) {
      buys.push({ market: s, type: "buy", sizeBps: Math.max(1, Math.min(10000, Math.floor(-diff))), currentBps: Math.round(cur), targetBps: tgt });
    }
  }
  return [...sells, ...buys];
}

/** Numeric param by name (or undefined). */

export function numParam(params: GenericParams | undefined, name: string | undefined): number | undefined {
  if (!name || !params) return undefined;
  const v = params[name];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export type RulesPreset = Pick<PresetInfo, "rules">;
