import { describe, expect, it } from "vitest";
import { runnerConfig } from "../src/config.js";
import { evaluateWatchdog, fillsOfAgent, Watchdog } from "../src/watchdog.js";
import { makeWorld } from "./helpers.js";

describe("evaluateWatchdog", () => {
  const base = {
    risk: { maxPositionBps: 5000, maxTradeBps: 1000, maxDailyLossBps: 500, maxTradesPerDay: 3, durationDays: 0 },
    markets: [{ symbol: "NVDA", coin: "NVDA/USDG" }],
    balances: { usdc: 500, tokens: { NVDA: 12.5 } }, // 500 + 500 -> 50%
    mids: { NVDA: 40 },
    dayStartEquity: 1000,
    llmTradesToday: 1,
    builderFillsToday: [],
    tolerance: { positionBps: 1000, lossBps: 500 },
  };
  it("within the limits -> no violations", () => {
    expect(evaluateWatchdog(base)).toEqual([]);
  });
  it("position share, daily loss, trade count, trades outside the agent's markets", () => {
    expect(evaluateWatchdog({ ...base, balances: { usdc: 100, tokens: { NVDA: 25 } } }).map((v) => v.code)).toEqual(["position_limit"]);
    expect(evaluateWatchdog({ ...base, dayStartEquity: 1200 }).map((v) => v.code)).toEqual(["daily_loss"]);
    expect(evaluateWatchdog({ ...base, llmTradesToday: 4 }).map((v) => v.code)).toEqual(["trades_per_day"]);
    const fill = { coin: "BABA/USDG", px: 1, sz: 1, side: "B" as const, time: 1, oid: 1, builderFee: 0.01 };
    expect(evaluateWatchdog({ ...base, builderFillsToday: [fill] }).map((v) => v.code)).toEqual(["non_whitelisted_trade"]);
  });

  it("buys in disabled or below-threshold markets are violations; sells (exits) are not", () => {
    const b = {
      risk: { maxPositionBps: 10000, maxTradeBps: 10000, maxDailyLossBps: 10000, maxTradesPerDay: 100, durationDays: 0 },
      balances: { usdc: 100, tokens: {} },
      mids: {},
      dayStartEquity: null,
      llmTradesToday: 0,
      tolerance: { positionBps: 0, lossBps: 0 },
      minMarketDayVolumeUsd: 5000,
    };
    let oid = 0;
    const fill = (coin: string, side: "B" | "A") => ({ coin, px: 1, sz: 1, side, time: 0, oid: ++oid, builderFee: 0.001 });
    const markets = [
      { symbol: "MU", coin: "MU/USDG", enabled: false, dayVolumeUsd: 1e6 },
      { symbol: "AMD", coin: "AMD/USDG", enabled: true, dayVolumeUsd: 100 },
      { symbol: "TSLA", coin: "TSLA/USDG", enabled: true, dayVolumeUsd: 1e6 },
    ];
    const v1 = evaluateWatchdog({ ...b, markets, builderFillsToday: [fill("MU/USDG", "B"), fill("AMD/USDG", "B"), fill("TSLA/USDG", "B")] });
    expect(v1.map((v) => v.code)).toEqual(["illiquid_market_trade"]);
    expect(v1[0]!.message).toContain("MU");
    expect(v1[0]!.message).toContain("AMD");
    const v2 = evaluateWatchdog({ ...b, markets, builderFillsToday: [fill("MU/USDG", "A"), fill("AMD/USDG", "A"), fill("TSLA/USDG", "B")] });
    expect(v2).toEqual([]);
  });
});

describe("fillsOfAgent: fills on a shared account are attributed by oid (production regression)", () => {
  it("an order of another agent is not this agent's trade; an unknown order attributed to the platform stays", () => {
    const fills = [
      { oid: 1, coin: "COIN/USDG" },
      { oid: 2, coin: "NVDA/USDG" },
      { oid: 3, coin: "BABA/USDG" },
    ];
    expect(fillsOfAgent(fills, new Set([1])).map((f) => f.oid)).toEqual([2, 3]);
  });
});

describe("Watchdog", () => {
  it("a violation -> off-chain pause + alert", async () => {
    const w = await makeWorld();
    const risk = { maxPositionBps: 5000, maxTradeBps: 1000, maxDailyLossBps: 500, maxTradesPerDay: 3, durationDays: 0 };
    const owner = "0x00000000000000000000000000000000000000e1" as const;
    const hlAccount = "0x00000000000000000000000000000000000000f1" as const;
    w.store.upsertChainAgent({
      id: 1,
      owner,
      presetId: 0,
      locked: false,
      chainStatus: 0,
      intervalSec: 300,
      createdAt: 0,
      sourceAgentId: 0,
      specHash: "0x1",
      modelId: "0x2",
      hlAccount,
      apiWallet: "0x00000000000000000000000000000000000000f2",
      risk,
    });
    w.store.activateAgent(1, {
      version: 1,
      preset: "dca",
      name: "n",
      goal: "",
      markets: ["NVDA"],
      quote: "USDG",
      model: "model-a",
      intervalSec: 300,
      profile: "balanced",
      risk,
      params: {},
    });
    w.exchange.balances.set(hlAccount, [
      { coin: "USDG", total: 10, hold: 0, entryNtl: 0 },
      { coin: "NVDA", total: 100, hold: 0, entryNtl: 0 },
    ]);
    const alerts: string[] = [];
    const wd = new Watchdog({ store: w.store, exchange: w.exchange, config: runnerConfig(), alerter: { send: async (t) => void alerts.push(t) } });
    expect(await wd.checkAll()).toBe(1);
    expect(w.store.getAgent(1)!.offchainStatus).toBe("paused");
    expect(w.store.getAgent(1)!.pauseReason).toBe("watchdog:position_limit");
    expect(alerts[0]).toContain("Agent #1 was paused by the watchdog");
    expect(w.store.listRunnableAgents()).toHaveLength(0);
  });
});
