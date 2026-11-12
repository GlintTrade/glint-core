// Indicators available to ANY preset (IndicatorSpec). All functions are pure;
// input is close prices in ascending time order.
import type { IndicatorSpec, Timeframe } from "@glint/strategy";

/** OHLCV candle (Lighter candles shape, numbers parsed). */
export interface Candle {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** EMA seeded with the SMA of the first `period` values. Returns the last value, or null if there is not enough data. */
export function ema(closes: number[], period: number): number | null {
  if (period < 1 || closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

/** Wilder's RSI. null if there are fewer than period + 1 points. */
export function rsi(closes: number[], period: number): number | null {
  if (period < 1 || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Price change over `lookback` candles, % (last close vs the close `lookback` candles earlier). */
export function change(closes: number[], lookback: number): number | null {
  if (lookback < 1 || closes.length < lookback + 1) return null;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 1 - lookback];
  if (!(prev > 0)) return null;
  return ((last - prev) / prev) * 100;
}

/** Sample standard deviation of simple returns over `lookback` candles, %. */
export function volatility(closes: number[], lookback: number): number | null {
  if (lookback < 2 || closes.length < lookback + 1) return null;
  const xs = closes.slice(-(lookback + 1));
  const rets: number[] = [];
  for (let i = 1; i < xs.length; i++) if (xs[i - 1] > 0) rets.push(xs[i] / xs[i - 1] - 1);
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 100;
}

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
};

/** Candles needed for an indicator (with headroom for EMA/RSI warm-up). */
export function candlesNeeded(spec: IndicatorSpec): number {
  switch (spec.kind) {
    case "ema":
      return spec.period * 3 + 5;
    case "rsi":
      return spec.period * 3 + 5;
    case "change":
    case "volatility":
      return spec.lookback + 2;
  }
}

export function indicatorLabel(spec: IndicatorSpec): string {
  switch (spec.kind) {
    case "ema":
    case "rsi":
      return `${spec.kind}${spec.period}_${spec.timeframe}`;
    case "change":
    case "volatility":
      return `${spec.kind}${spec.lookback}_${spec.timeframe}`;
  }
}

export function computeIndicator(spec: IndicatorSpec, closes: number[]): number | null {
  switch (spec.kind) {
    case "ema":
      return ema(closes, spec.period);
    case "rsi":
      return rsi(closes, spec.period);
    case "change":
      return change(closes, spec.lookback);
    case "volatility":
      return volatility(closes, spec.lookback);
  }
}

/**
 * Agent parameters may override preset indicators without any preset-specific logic:
 * a "timeframe" param (valid Timeframe) replaces the timeframe of every indicator;
 * "fastEma"/"slowEma" replace the periods of the first/second EMA in order.
 * This is a naming convention, not a branch per preset.
 */
export function resolveIndicatorSpecs(specs: IndicatorSpec[], params: Record<string, unknown>): IndicatorSpec[] {
  const tf = typeof params.timeframe === "string" && params.timeframe in TIMEFRAME_MS ? (params.timeframe as Timeframe) : undefined;
  const emaPeriods = [params.fastEma, params.slowEma].filter((x): x is number => typeof x === "number" && x >= 1);
  let emaIdx = 0;
  return specs.map((s) => {
    const out = { ...s, ...(tf ? { timeframe: tf } : {}) } as IndicatorSpec;
    if (out.kind === "ema" && emaIdx < emaPeriods.length) {
      return { ...out, period: Math.floor(emaPeriods[emaIdx++]) };
    }
    return out;
  });
}

export type CandleFetcher = (coin: string, timeframe: Timeframe, startTimeMs: number) => Promise<Candle[]>;

/** Computes every indicator for one market, fetching candles once per timeframe. */

export async function computeIndicators(
  specs: IndicatorSpec[],
  coin: string,
  fetch: CandleFetcher,
  nowMs = Date.now(),
): Promise<Record<string, number | null>> {
  const byTf = new Map<Timeframe, number>();
  for (const s of specs) byTf.set(s.timeframe, Math.max(byTf.get(s.timeframe) ?? 0, candlesNeeded(s)));
  const closesByTf = new Map<Timeframe, number[]>();
  for (const [tf, n] of byTf) {
    const candles = await fetch(coin, tf, nowMs - (n + 1) * TIMEFRAME_MS[tf]);
    closesByTf.set(
      tf,
      [...candles]
        .sort((a, b) => a.t - b.t)
        .map((c) => c.c)
        .filter((c) => Number.isFinite(c) && c > 0),
    );
  }
  const out: Record<string, number | null> = {};
  for (const s of specs) {
    const v = computeIndicator(s, closesByTf.get(s.timeframe) ?? []);
    out[indicatorLabel(s)] = v === null ? null : Number(v.toFixed(6));
  }
  return out;
}
