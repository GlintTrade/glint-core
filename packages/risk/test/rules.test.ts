// Preset rules enforced by code (PresetInfo.rules): DCA interval/budget/buy-below, Trend entry on fast EMA > slow EMA,
// Rebalance targets, Momentum entry conditions with { param } operands and the position cap.
import { type AgentAction, PRESETS, type RiskBox } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { evalConditions, evaluateDecision, indicatorLabels, indicatorValues, type RiskInput, rebalancePlan } from "../src/index.js";

const dca = PRESETS.find((p) => p.key === "dca")!;
const trend = PRESETS.find((p) => p.key === "trend")!;
const rebalance = PRESETS.find((p) => p.key === "rebalance")!;
const momentum = PRESETS.find((p) => p.key === "momentum")!;
const mkt = [{ symbol: "NVDA", coin: "NVDA/USDG", hlSpotIndex: 107, szDecimals: 2, buyable: true }];

const input = (over: Partial<RiskInput>): RiskInput => ({
  spec: { markets: ["NVDA"], risk: { maxPositionBps: 9000, maxTradeBps: 5000, maxDailyLossBps: 600, maxTradesPerDay: 50, durationDays: 0 } },
  preset: dca,
  params: { buyEverySec: 3600, budgetPerBuyBps: 500 },
  markets: mkt,
  balances: { usdc: 1000, tokens: { NVDA: 0 } },
  mids: { NVDA: 40 },
  tradesToday: 0,
  dailyPnlBps: 0,
  decision: { actions: [{ type: "buy", market: "NVDA", sizeBps: 400, reason: "x" }], note: "" },
  ...over,
});

describe("evalConditions", () => {
  it("true / false / null (missing data)", () => {
    const c = [{ left: { ind: 0 }, op: ">" as const, right: { ind: 1 } }];
    expect(evalConditions(c, [2, 1], 0)).toBe(true);
    expect(evalConditions(c, [1, 2], 0)).toBe(false);
    expect(evalConditions(c, [null, 2], 0)).toBe(null);
    expect(evalConditions([{ left: { price: true }, op: "<=", right: { value: 41 } }], [], 40)).toBe(true);
    expect(evalConditions(undefined, undefined, 0)).toBe(true);
  });
  it("indicator labels follow fastEma/slowEma/timeframe overrides", () => {
    expect(indicatorLabels(trend.indicators, { timeframe: "4h", fastEma: 9, slowEma: 21 })).toEqual(["ema9_4h", "ema21_4h", "rsi14_4h"]);
    expect(indicatorValues(["a", "b"], { a: 1 })).toEqual([1, null]);
  });
});

describe("DCA rules (buyEverySec / budgetPerBuyBps / buyBelowUsd)", () => {
  it("first buy within budget is ok; an immediate second one is buy_too_soon; one buy per batch", () => {
    expect(evaluateDecision(input({ secondsSinceLastBuy: null })).orders).toHaveLength(1);
    expect(evaluateDecision(input({ secondsSinceLastBuy: 100 })).rejections[0].code).toBe("buy_too_soon");
    expect(evaluateDecision(input({ secondsSinceLastBuy: 3600 })).orders).toHaveLength(1);
    const two = evaluateDecision(
      input({
        decision: {
          note: "",
          actions: [
            { type: "buy", market: "NVDA", sizeBps: 300, reason: "a" },
            { type: "buy", market: "NVDA", sizeBps: 300, reason: "b" },
          ],
        },
      }),
    );
    expect(two.orders).toHaveLength(1);
    expect(two.rejections[0].code).toBe("buy_too_soon");
  });
  it("above budgetPerBuyBps -> buy_budget_exceeded; price above buyBelowUsd -> above_buy_price", () => {
    expect(evaluateDecision(input({ decision: { note: "", actions: [{ type: "buy", market: "NVDA", sizeBps: 600, reason: "x" }] } })).rejections[0].code).toBe(
      "buy_budget_exceeded",
    );
    expect(evaluateDecision(input({ params: { buyEverySec: 3600, budgetPerBuyBps: 500, buyBelowUsd: { NVDA: 35 } } })).rejections[0].code).toBe(
      "above_buy_price",
    );
    expect(evaluateDecision(input({ params: { buyEverySec: 3600, budgetPerBuyBps: 500, buyBelowUsd: { NVDA: 45 } } })).orders).toHaveLength(1);
  });
});

describe("Trend rules (buyWhen fast EMA > slow EMA)", () => {
  const base = {
    preset: trend,
    params: trend.defaults.balanced.params,
    decision: { note: "", actions: [{ type: "buy" as const, market: "NVDA", sizeBps: 1000, reason: "x" }] },
  };
  it("enters only when fast > slow; missing data rejects", () => {
    expect(evaluateDecision(input({ ...base, indicators: { NVDA: [41, 40, 55] } })).orders).toHaveLength(1);
    expect(evaluateDecision(input({ ...base, indicators: { NVDA: [39, 40, 55] } })).rejections[0].code).toBe("buy_condition_failed");
    expect(evaluateDecision(input({ ...base, indicators: {} })).rejections[0].code).toBe("buy_condition_failed");
  });
});

const risk: RiskBox = { maxPositionBps: 9000, maxTradeBps: 9000, maxDailyLossBps: 2000, maxTradesPerDay: 20, durationDays: 0 };
const markets = [
  { symbol: "NVDA", coin: "NVDA/USDG", hlSpotIndex: 107, szDecimals: 2 },
  { symbol: "SPY", coin: "SPY/USDG", hlSpotIndex: 140, szDecimals: 5 },
];
const a = (type: "buy" | "sell", market: string, sizeBps: number): AgentAction => ({ type, market, sizeBps, reason: "r" });

describe("rebalancePlan", () => {
  const base = { bandBps: 500, mids: { NVDA: 40, SPY: 100000 }, buyable: () => true };
  it("share above target -> sell part of the position; below -> buy; within the band -> nothing", () => {
    // equity 1000: NVDA 7000 bps (17.5 x 40), target 5000 -> sell 2000/7000 = 2857 bps of the position
    const sellPlan = rebalancePlan({ ...base, targets: { NVDA: 5000 }, equity: 1000, balances: { usdc: 300, tokens: { NVDA: 17.5 } } });
    expect(sellPlan).toEqual([{ market: "NVDA", type: "sell", sizeBps: 2857, currentBps: 7000, targetBps: 5000 }]);
    const buyPlan = rebalancePlan({ ...base, targets: { NVDA: 5000 }, equity: 1000, balances: { usdc: 700, tokens: { NVDA: 7.5 } } });
    expect(buyPlan).toEqual([{ market: "NVDA", type: "buy", sizeBps: 2000, currentBps: 3000, targetBps: 5000 }]);
    expect(rebalancePlan({ ...base, targets: { NVDA: 5000 }, equity: 1000, balances: { usdc: 520, tokens: { NVDA: 12 } } })).toEqual([]);
  });
  it("a token without a target is sold entirely; sells come before buys", () => {
    const p = rebalancePlan({ ...base, targets: { NVDA: 5000 }, equity: 1000, balances: { usdc: 900, tokens: { SPY: 0.001 } } });
    expect(p.map((x) => [x.type, x.market, x.sizeBps])).toEqual([
      ["sell", "SPY", 10000],
      ["buy", "NVDA", 5000],
    ]);
  });
});

describe("risk engine: rules.rebalance never trades beyond targets", () => {
  const inp = (actions: AgentAction[], tokens: Record<string, number>, usdc: number): RiskInput => ({
    spec: { markets: ["NVDA", "SPY"], risk },
    preset: { allowsBuy: true, allowsSell: true, rules: rebalance.rules },
    params: { targets: { NVDA: 5000 }, driftBandBps: 500, minRebalanceSec: 0, maxRebalanceTradeBps: 9000 },
    markets,
    balances: { usdc, tokens },
    mids: { NVDA: 40, SPY: 100000 },
    tradesToday: 0,
    dailyPnlBps: 0,
    limits: { minOrderUsd: 10, maxSlippageBps: 100 },
    decision: { actions, note: "" },
  });
  it("a buy above the target -> exceeds_target; a buy up to the target is ok", () => {
    expect(evaluateDecision(inp([a("buy", "NVDA", 3000)], { NVDA: 7.5 }, 700)).rejections[0]?.code).toBe("exceeds_target");
    expect(evaluateDecision(inp([a("buy", "NVDA", 2000)], { NVDA: 7.5 }, 700)).orders).toHaveLength(1);
  });
  it("a sell below the target -> exceeds_target; a token without a target can be sold entirely", () => {
    expect(evaluateDecision(inp([a("sell", "NVDA", 10000)], { NVDA: 17.5 }, 300)).rejections[0]?.code).toBe("exceeds_target");
    expect(evaluateDecision(inp([a("sell", "NVDA", 2800)], { NVDA: 17.5 }, 300)).orders).toHaveLength(1);
    expect(evaluateDecision(inp([a("sell", "SPY", 10000)], { SPY: 0.001 }, 900)).orders).toHaveLength(1);
  });
  it("a protective sell (stop) is not bound by targets", () => {
    expect(evaluateDecision(inp([a("sell", "NVDA", 10000)], { NVDA: 17.5 }, 300), { protective: true }).orders).toHaveLength(1);
  });
});

describe("Momentum: entry conditions with { param } operands and the position cap", () => {
  const params = momentum.defaults.balanced.params; // minChange24hPct 6, RSI 55..80, maxPositions 3
  it("evalConditions compares indicators with agent params", () => {
    const conds = momentum.rules!.buyWhen!;
    expect(evalConditions(conds, [8, 60, 1.1, 1.0], 1, params)).toBe(true); // +8%, RSI 60, EMA9 > EMA21
    expect(evalConditions(conds, [3, 60, 1.1, 1.0], 1, params)).toBe(false); // not enough movement
    expect(evalConditions(conds, [8, 85, 1.1, 1.0], 1, params)).toBe(false); // overbought
    expect(evalConditions(conds, [8, 60, 0.9, 1.0], 1, params)).toBe(false); // EMA pointing down
    expect(evalConditions(conds, [8, 60, 1.1, 1.0], 1, {})).toBeNull(); // no params, no data
  });
  it("risk engine: buy_condition_failed without a breakout; too_many_positions beyond maxPositions", () => {
    const inp = (indicators: Record<string, (number | null)[]>, tokens: Record<string, number>): RiskInput => ({
      spec: { markets: ["*"], risk },
      preset: { allowsBuy: true, allowsSell: true, rules: momentum.rules },
      params: { ...params, maxPositions: 1 },
      indicators,
      secondsSinceLastBuy: null,
      markets,
      balances: { usdc: 1000, tokens },
      mids: { NVDA: 40, SPY: 100000 },
      tradesToday: 0,
      dailyPnlBps: 0,
      limits: { minOrderUsd: 10, maxSlippageBps: 100 },
      decision: { actions: [a("buy", "NVDA", 3000)], note: "" },
    });
    expect(evaluateDecision(inp({ NVDA: [2, 60, 1.1, 1] }, {})).rejections[0]?.code).toBe("buy_condition_failed");
    expect(evaluateDecision(inp({ NVDA: [9, 60, 1.1, 1] }, {})).orders).toHaveLength(1);
    expect(evaluateDecision(inp({ NVDA: [9, 60, 1.1, 1] }, { SPY: 0.002 })).rejections[0]?.code).toBe("too_many_positions");
  });
});
