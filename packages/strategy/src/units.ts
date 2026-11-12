// Strategy parameters in plain words and human units: shares (bps) -> %, waits (*Sec) -> minutes/hours.
// Shared by the website, the backend (template listing descriptions) and the MCP server.
// Spec values never change (bps, seconds); only their presentation does.
import type { PresetParamField, PresetParamValue, RiskBox } from "./types.js";

/** Label and hint for known parameter keys; unknown keys fall back to the paramsSchema label. */
export const PARAM_COPY: Record<string, { label: string; help: string }> = {
  buyEverySec: { label: "Minimum time between buys", help: "The agent buys at most once in this period." },
  cooldownSec: { label: "Minimum time between buys", help: "After a buy the agent waits at least this long before the next one." },
  budgetPerBuyBps: { label: "Size of each buy", help: "Share of the agent's capital spent on a single buy." },
  stopLossPct: { label: "Stop-loss", help: "Sells a position that falls this far below its entry price." },
  takeProfitPct: { label: "Take-profit", help: "Sells a position that rises this far above its entry price." },
  trailingPct: { label: "Trailing stop", help: "Sells if the price drops this far from its highest point since the buy." },
  timeframe: { label: "Chart timeframe", help: "Candle size the trend is read on: 15m reacts faster, 4h is calmer." },
  fastEma: { label: "Fast average, candles", help: "Short moving average. The trend is up while it stays above the slow one." },
  slowEma: { label: "Slow average, candles", help: "Long moving average that defines the main trend." },
  targets: { label: "Target portfolio", help: "" },
  driftBandBps: { label: "Rebalance when off target by", help: "A token is rebalanced once its share moves this far from its target." },
  minRebalanceSec: { label: "Minimum time between rebalances", help: "The agent rebalances at most once in this period." },
  maxRebalanceTradeBps: { label: "Max rebalance trade", help: "One rebalancing order is never larger than this share of capital." },
  minChange24hPct: { label: "Minimum 24h rise to enter", help: "Only tokens up at least this much over the last 24 hours are considered." },
  rsiMin: { label: "RSI from", help: "RSI (0 to 100) measures momentum. The agent enters only inside this range." },
  rsiMax: { label: "RSI up to", help: "Above about 70 a move is often overheated." },
  maxPositions: { label: "Max tokens held at once", help: "How many different tokens the agent may hold at the same time." },
};

/** Display unit: pct = value in bps (divided by 100), min = seconds, raw = as is. */
export type ParamUnit = "pct" | "min" | "raw";

export function paramUnit(key: string): ParamUnit {
  if (/Bps$/.test(key)) return "pct";
  if (/Sec$/.test(key)) return "min";
  return "raw";
}

export function paramLabel(f: Pick<PresetParamField, "key" | "label">): string {
  return PARAM_COPY[f.key]?.label ?? f.label.replace(/,\s*bps\b.*$/i, "");
}

const trim2 = (v: number) => String(Math.round(v * 100) / 100);

/** bps → "12.5%" */
export const bpsPct = (bps: number) => `${trim2(bps / 100)}%`;

/** Duration in words: 21600 → "6 hours", 90 → "1.5 minutes", 129600 → "36 hours", 259200 → "3 days". */
export function durationWords(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  const unit = (n: number, w: string) => `${trim2(n)} ${w}${n === 1 ? "" : "s"}`;
  if (s >= 86400 && (s % 86400 === 0 || s > 86400 * 2)) return unit(s / 86400, "day");
  if (s >= 3600 && (s % 3600 === 0 || s > 7200)) return unit(s / 3600, "hour");
  if (s >= 60) return unit(s / 60, "minute");
  return unit(s, "second");
}

/** Parameter value in human units: "5%", "6 hours", "NVDA 50%, SPY 30% (20% stays in USDG)", "4h". */
export function formatParamValue(f: Pick<PresetParamField, "key" | "type">, v: PresetParamValue | undefined): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    const u = paramUnit(f.key);
    if (u === "pct") return bpsPct(v);
    if (u === "min") return durationWords(v);
    if (/Pct$/.test(f.key)) return `${trim2(v)}%`;
    return trim2(v);
  }
  if (typeof v === "object") {
    const rows = Object.entries(v).filter(([, x]) => typeof x === "number" && Number.isFinite(x));
    if (!rows.length) return "—";
    const sum = rows.reduce((s, [, x]) => s + x, 0);
    const rest = Math.max(0, 10000 - sum);
    return `${rows.map(([k, x]) => `${k} ${bpsPct(x)}`).join(", ")}${rest > 0 ? ` (${bpsPct(rest)} stays in USDG)` : ""}`;
  }
  return String(v);
}

/** Risk limits as one sentence. */
export function riskWords(r: RiskBox): string {
  return [
    `at most ${bpsPct(r.maxPositionBps)} of capital in one token`,
    `at most ${bpsPct(r.maxTradeBps)} per trade`,
    `buying stops for the day after a ${bpsPct(r.maxDailyLossBps)} daily loss`,
    `up to ${r.maxTradesPerDay} trades a day`,
    r.durationDays ? `runs for ${r.durationDays} days` : "no end date",
  ].join("; ");
}

/** Markets in words: ["*"] = all enabled liquid pairs. */
export function marketsWords(markets: readonly string[] | undefined | null): string {
  if (!markets || markets.length === 0) return "—";
  if (markets.length === 1 && markets[0] === "*") return "any enabled liquid pair";
  return markets.join(", ");
}
