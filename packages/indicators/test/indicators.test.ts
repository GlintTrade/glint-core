import { describe, expect, it } from "vitest";
import { candlesNeeded, change, computeIndicators, ema, indicatorLabel, resolveIndicatorSpecs, rsi, volatility } from "../src/index.js";

describe("indicators", () => {
  it("EMA: constant input gives a constant; seed = SMA", () => {
    expect(ema([5, 5, 5, 5, 5], 3)).toBe(5);
    expect(ema([1, 2, 3], 3)).toBe(2);
    expect(ema([1, 2, 3, 4], 3)).toBe(3); // seed 2, k = 0.5, 4 -> 3
    expect(ema([1, 2], 3)).toBeNull();
  });
  it("RSI: only gains -> 100, only losses -> 0, flat -> 50", () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 5)).toBe(100);
    expect(rsi([6, 5, 4, 3, 2, 1], 5)).toBe(0);
    expect(rsi([3, 3, 3, 3, 3, 3], 5)).toBe(50);
    expect(rsi([1, 2], 5)).toBeNull();
  });
  it("RSI: Wilder's reference example (period 14)", () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(rsi(closes, 14)!).toBeCloseTo(70.46, 1);
  });
  it("change and volatility", () => {
    expect(change([100, 110, 121], 2)).toBeCloseTo(21, 6);
    expect(change([100], 1)).toBeNull();
    expect(volatility([100, 100, 100, 100], 3)).toBe(0);
    const v = volatility([100, 101, 100, 101, 100], 4)!;
    expect(v).toBeGreaterThan(0.9);
    expect(v).toBeLessThan(1.3);
  });
  it("agent params override timeframe / fastEma / slowEma", () => {
    const specs = resolveIndicatorSpecs(
      [
        { kind: "ema", period: 20, timeframe: "1h" },
        { kind: "ema", period: 50, timeframe: "1h" },
        { kind: "rsi", period: 14, timeframe: "1h" },
      ],
      { timeframe: "15m", fastEma: 9, slowEma: 21 },
    );
    expect(specs).toEqual([
      { kind: "ema", period: 9, timeframe: "15m" },
      { kind: "ema", period: 21, timeframe: "15m" },
      { kind: "rsi", period: 14, timeframe: "15m" },
    ]);
    expect(resolveIndicatorSpecs([{ kind: "change", lookback: 24, timeframe: "1h" }], { timeframe: "bogus" })).toEqual([
      { kind: "change", lookback: 24, timeframe: "1h" },
    ]);
  });
  it("labels and warm-up sizes", () => {
    expect(indicatorLabel({ kind: "ema", period: 20, timeframe: "1h" })).toBe("ema20_1h");
    expect(indicatorLabel({ kind: "change", lookback: 24, timeframe: "1h" })).toBe("change24_1h");
    expect(candlesNeeded({ kind: "rsi", period: 14, timeframe: "1h" })).toBe(47);
  });
  it("computeIndicators fetches candles once per timeframe", async () => {
    const calls: string[] = [];
    const out = await computeIndicators(
      [
        { kind: "ema", period: 3, timeframe: "1h" },
        { kind: "change", lookback: 2, timeframe: "1h" },
        { kind: "rsi", period: 3, timeframe: "4h" },
      ],
      "NVDA/USDG",
      async (coin, tf, start) => {
        calls.push(`${coin}:${tf}`);
        return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((c, i) => ({ t: start + i, o: c, h: c, l: c, c, v: 1 }));
      },
      1_700_000_000_000,
    );
    expect(calls.sort()).toEqual(["NVDA/USDG:1h", "NVDA/USDG:4h"]);
    expect(out).toMatchObject({ ema3_1h: 14, rsi3_4h: 100 });
    expect(out.change2_1h).toBeCloseTo(((15 - 13) / 13) * 100, 4);
  });
});
