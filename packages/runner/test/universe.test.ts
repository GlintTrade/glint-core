// The agent's markets: protective sells on disabled/illiquid markets, the "*" mode (all liquid pairs), lot-size rules.
import type { ResolvedMarket } from "@glint/lighter";
import { evaluateDecision, type RiskInput } from "@glint/risk";
import { ALL_MARKETS, PRESETS, type StrategySpec } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { lc } from "../src/types.js";
import { affordableBuy, agentUniverse, buildShortlist, heldSymbols, minSellShareBps } from "../src/universe.js";
import { evaluateWatchdog } from "../src/watchdog.js";
import { addAgent, FakeProvider, HL_ACC, makeWorld } from "./helpers.js";

const mk = (symbol: string, over: Partial<ResolvedMarket> = {}): ResolvedMarket => ({
  symbol,
  pair: `${symbol}/USDG`,
  hlSpotIndex: symbol.length,
  szDecimals: 2,
  enabled: true,
  coin: `@${symbol}`,
  resolved: true,
  dayVolumeUsd: 100_000,
  midUsd: 10,
  ...over,
});

describe("buildShortlist / agentUniverse", () => {
  const all = [
    mk("A", { dayVolumeUsd: 10_000_000, change24hPct: 1 }),
    mk("B", { dayVolumeUsd: 9_000_000, change24hPct: 25 }),
    mk("C", { dayVolumeUsd: 50_000, change24hPct: 0 }),
    mk("D", { dayVolumeUsd: 8_000_000, enabled: false }), // disabled: not a candidate
    mk("E", { dayVolumeUsd: 1_000, enabled: false, change24hPct: -40 }), // illiquid, auto-disabled
    mk("F", { resolved: false }),
  ];

  it("shortlist: enabled only, without excluded, ranked by volume + move, deterministic", () => {
    const s = buildShortlist(all, new Set(), 2).map((m) => m.symbol);
    expect(s).toEqual(["B", "A"]); // B: almost the same volume, but +25% over 24h
    expect(buildShortlist(all, new Set(["B"]), 5).map((m) => m.symbol)).toEqual(["A", "C"]);
    expect(buildShortlist(all, new Set(), 0)).toEqual([]);
  });

  it("selected pairs: a disabled market stays (to sell) with buyable=false; unknown and unresolved are dropped", () => {
    const u = agentUniverse(["A", "E", "F", "ZZZ"], all, [], 12);
    expect(u.map((m) => [m.symbol, m.buyable])).toEqual([
      ["A", true],
      ["E", false],
    ]);
  });

  it('"*" mode: held positions (even on a disabled market) + a shortlist of N enabled markets', () => {
    const u = agentUniverse([ALL_MARKETS], all, ["E", "C"], 1);
    expect(u.map((m) => [m.symbol, m.buyable])).toEqual([
      ["E", false],
      ["C", true],
      ["B", true],
    ]);
  });

  it("heldSymbols: dust below $1 and the quote (USDG, USDC) are not positions", () => {
    expect(heldSymbols({ A: 0.05, B: 2, USDG: 100, USDC: 5 }, { A: 10, B: 10, USDG: 1, USDC: 1 }).sort()).toEqual(["B"]);
  });
});

describe('risk engine: buyable and the "*" mode', () => {
  const trend = PRESETS.find((p) => p.key === "trend")!;
  const base = (over: Partial<RiskInput>): RiskInput => ({
    spec: { markets: ["NVDA", "AMD"], risk: { maxPositionBps: 5000, maxTradeBps: 2500, maxDailyLossBps: 600, maxTradesPerDay: 10, durationDays: 0 } },
    preset: { allowsBuy: trend.allowsBuy, allowsSell: trend.allowsSell },
    markets: [
      { symbol: "NVDA", coin: "NVDA/USDG", hlSpotIndex: 107, szDecimals: 2, buyable: true },
      { symbol: "AMD", coin: "AMD/USDG", hlSpotIndex: 0, szDecimals: 0, buyable: false },
    ],
    balances: { usdc: 1000, tokens: { NVDA: 0, AMD: 1000 } },
    mids: { NVDA: 40, AMD: 0.2 },
    tradesToday: 0,
    dailyPnlBps: 0,
    decision: { actions: [], note: "" },
    ...over,
  });

  it("a buy on a disabled/illiquid market is rejected; selling the position there is allowed", () => {
    const r = evaluateDecision(
      base({
        decision: {
          note: "",
          actions: [
            { type: "buy", market: "AMD", sizeBps: 500, reason: "x" },
            { type: "sell", market: "AMD", sizeBps: 10000, reason: "exit" },
          ],
        },
      }),
    );
    expect(r.rejections.map((x) => [x.index, x.code])).toEqual([[0, "market_not_whitelisted"]]);
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ side: "sell", market: "AMD", sizeBase: "1000" });
  });

  it('"*": any buyable market can be bought without market_not_in_spec; equity counts every token of the set', () => {
    const r = evaluateDecision(
      base({
        spec: { markets: [ALL_MARKETS], risk: base({}).spec.risk },
        markets: [
          { symbol: "NVDA", coin: "NVDA/USDG", hlSpotIndex: 107, szDecimals: 2, buyable: true },
          { symbol: "SPY", coin: "SPY/USDG", hlSpotIndex: 140, szDecimals: 5, buyable: true },
        ],
        balances: { usdc: 1000, tokens: { NVDA: 0, SPY: 0 } },
        mids: { NVDA: 40, SPY: 100000 },
        decision: { note: "", actions: [{ type: "buy", market: "SPY", sizeBps: 1000, reason: "x" }] },
      }),
    );
    expect(r.rejections).toEqual([]);
    expect(r.orders[0]).toMatchObject({ market: "SPY", side: "buy" });
    expect(r.equityUsd).toBe(1000);
  });

  it('"*": distinct position limit (maxDistinctPositions): a new position is rejected, adding to an existing one is not', () => {
    const syms = ["T1", "T2", "T3"];
    const markets = [...syms, "NEW"].map((s, i) => ({ symbol: s, coin: `@${i}`, hlSpotIndex: i, szDecimals: 2, buyable: true }));
    const tokens = Object.fromEntries(syms.map((s) => [s, 10]));
    const mids = Object.fromEntries([...syms, "NEW"].map((s) => [s, 10]));
    const r = evaluateDecision(
      base({
        spec: { markets: [ALL_MARKETS], risk: { maxPositionBps: 9000, maxTradeBps: 2000, maxDailyLossBps: 600, maxTradesPerDay: 10, durationDays: 0 } },
        markets,
        balances: { usdc: 1000, tokens: { ...tokens, NEW: 0 } },
        mids,
        limits: { maxDistinctPositions: 3 },
        decision: {
          note: "",
          actions: [
            { type: "buy", market: "NEW", sizeBps: 500, reason: "x" },
            { type: "buy", market: "T1", sizeBps: 500, reason: "x" },
          ],
        },
      }),
    );
    expect(r.rejections.map((x) => [x.index, x.code])).toEqual([[0, "too_many_positions"]]);
    expect(r.orders.map((o) => o.market)).toEqual(["T1"]);
  });
});

describe("watchdog: distinct position limit", () => {
  it("fires only when maxDistinctPositions is set", () => {
    const base = {
      risk: { maxPositionBps: 10000, maxTradeBps: 10000, maxDailyLossBps: 10000, maxTradesPerDay: 100, durationDays: 0 },
      markets: ["A", "B", "C"].map((s) => ({ symbol: s, coin: `@${s}` })),
      balances: { usdc: 0, tokens: { A: 1, B: 1, C: 1 } },
      mids: { A: 10, B: 10, C: 10 },
      dayStartEquity: null,
      llmTradesToday: 0,
      builderFillsToday: [],
      tolerance: { positionBps: 0, lossBps: 0 },
    };
    expect(evaluateWatchdog(base).map((v) => v.code)).toEqual([]);
    expect(evaluateWatchdog({ ...base, maxDistinctPositions: 2 }).map((v) => v.code)).toEqual(["too_many_positions"]);
  });
});

describe('runner: protective sells on a disabled market, "*" mode', () => {
  const trend = PRESETS.find((p) => p.key === "trend")!;

  async function setup(markets: string[], balances: { coin: string; total: number; hold: number; entryNtl: number }[]) {
    const now = Math.floor(Date.now() / 1000);
    const primary = new FakeProvider("primary");
    const w = await makeWorld({ primary, now: () => now });
    const spec: StrategySpec = {
      version: 1,
      preset: "trend",
      name: "t",
      goal: "",
      markets,
      quote: "USDG",
      model: "model-a",
      intervalSec: 300,
      profile: "balanced",
      risk: trend.defaults.balanced.risk,
      params: trend.defaults.balanced.params,
    };
    addAgent(w, { id: 1, spec, createdAt: now - 1000 });
    w.exchange.balances.set(lc(HL_ACC), balances);
    return w;
  }

  it("market disabled: the stop-loss on the position is still executed by code", async () => {
    const t = await setup(
      ["NVDA"],
      [
        { coin: "USDG", total: 100, hold: 0, entryNtl: 0 },
        { coin: "NVDA", total: 10, hold: 0, entryNtl: 500 },
      ],
    );
    t.store.setMarketEnabled("NVDA", false);
    const out = await t.runner.tickAgent(t.store.getAgent(1)!);
    expect(out.kind).toBe("protect");
    expect(t.exchange.orders).toHaveLength(1);
    expect(t.exchange.orders[0]!.order).toMatchObject({ isBuy: false, size: "10" });
  });

  it("market disabled: the AI may sell the position, a buy is rejected", async () => {
    const t = await setup(
      ["NVDA"],
      [
        { coin: "USDG", total: 1000, hold: 0, entryNtl: 0 },
        { coin: "NVDA", total: 5, hold: 0, entryNtl: 190 },
      ],
    );
    t.store.setMarketEnabled("NVDA", false);
    t.primary.queue.push(
      JSON.stringify({
        actions: [
          { type: "buy", market: "NVDA", sizeBps: 500, limitPriceUsd: null, reason: "buy more" },
          { type: "sell", market: "NVDA", sizeBps: 10000, limitPriceUsd: null, reason: "exit" },
        ],
        note: "n",
      }),
    );
    const out = await t.runner.tickAgent(t.store.getAgent(1)!);
    expect(out.kind).toBe("decided");
    if (out.kind !== "decided") return;
    expect(out.rejections.map((r) => r.code)).toEqual(["market_not_whitelisted"]);
    expect(t.exchange.orders.map((o) => o.order.isBuy)).toEqual([false]);
  });

  it('"*": the AI gets a shortlist of enabled markets and may buy SPY, which is not in the spec', async () => {
    const t = await setup([ALL_MARKETS], [{ coin: "USDG", total: 1000, hold: 0, entryNtl: 0 }]);
    t.primary.queue.push(JSON.stringify({ actions: [{ type: "buy", market: "SPY", sizeBps: 1000, limitPriceUsd: null, reason: "momentum" }], note: "n" }));
    const out = await t.runner.tickAgent(t.store.getAgent(1)!);
    expect(out.kind).toBe("decided");
    const prompt = t.primary.calls[0]!.user;
    expect(prompt).toContain("NVDA");
    expect(prompt).toContain("SPY");
    expect(t.exchange.orders).toHaveLength(1);
    expect(t.exchange.orders[0]!.order.isBuy).toBe(true);
  });
});

describe("affordableBuy: lot step versus the minimum order", () => {
  it("a token at ~$612 with szDecimals 2: an $11.7 budget -> 0.01 = $6.12 < $10 -> not buyable", () => {
    expect(affordableBuy(2, 611.865, 11.7, 10)).toBe(false);
  });
  it("NVDA at ~$78.5, szDecimals 2: $11.7 -> 0.14 = $10.99 -> buyable", () => {
    expect(affordableBuy(2, 78.5, 11.7, 10)).toBe(true);
  });
  it("SPY at ~$75.9k, szDecimals 5: $11.7 -> 0.00015 = $11.38 -> buyable", () => {
    expect(affordableBuy(5, 75871.5, 11.7, 10)).toBe(true);
  });
  it("no price or no budget -> not buyable", () => {
    expect(affordableBuy(2, undefined, 100, 10)).toBe(false);
    expect(affordableBuy(2, 50, 0, 10)).toBe(false);
  });
  it('agentUniverse "*": pairs unaffordable by lot stay out of the shortlist, buyable ones take their place', () => {
    const m = (symbol: string, vol: number, szDecimals: number): ResolvedMarket =>
      mk(symbol, { hlSpotIndex: 1, szDecimals, dayVolumeUsd: vol, change24hPct: 1 });
    const all = [m("MU", 9e6, 2), m("NVDA", 1e8, 2), m("SPY", 7e7, 5), m("AMD", 2e6, 0)];
    const mids: Record<string, number> = { MU: 611.865, NVDA: 78.5, SPY: 75871.5, AMD: 0.2 };
    const canBuy = (x: ResolvedMarket) => affordableBuy(x.szDecimals, mids[x.symbol], 11.7, 10);
    const u = agentUniverse(["*"], all, [], 3, canBuy);
    expect(u.map((x) => x.symbol)).not.toContain("MU");
    expect(u.map((x) => x.symbol)).toEqual(expect.arrayContaining(["NVDA", "SPY", "AMD"]));
    // selected pairs: MU stays in the set (to sell a position) but cannot be bought
    const sel = agentUniverse(["MU", "NVDA"], all, [], 3, canBuy);
    expect(sel.find((x) => x.symbol === "MU")?.buyable).toBe(false);
    expect(sel.find((x) => x.symbol === "NVDA")?.buyable).toBe(true);
  });
});

describe("minSellShareBps: lot step and fill price (production regression)", () => {
  it("SPY 0.0002298455 @ 75998, szDecimals 5: the share yields >= $10 after rounding to 0.00001 and -3% on price", () => {
    const qty = 0.0002298455;
    const mid = 75998;
    const bps = minSellShareBps(qty, mid, 5, 10);
    const sold = Math.floor(((qty * bps) / 10000) * 1e5 + 1e-9) / 1e5;
    expect(sold * mid * 0.97).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(bps).toBeGreaterThan(5725); // exactly "10 / value" (~5725) was not enough
  });
  it("a position below the minimum order -> > 10000 (cannot be sold)", () => {
    expect(minSellShareBps(0.1, 50, 2, 10)).toBeGreaterThan(10000);
  });
});
