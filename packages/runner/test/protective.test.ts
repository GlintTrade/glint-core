// Protective exits by code are never capped by the per-decision action limit (AI decisions are).
import { evaluateDecision, type RiskInput } from "@glint/risk";
import { describe, expect, it } from "vitest";

describe("protective exits are not capped by actionsPerDecisionMax", () => {
  it("5 protective sells in one decision -> 5 orders (AI decisions stay capped at 3)", () => {
    const syms = ["A", "B", "C", "D", "E"];
    const markets = syms.map((s, i) => ({ symbol: s, coin: `@${i}`, hlSpotIndex: i, szDecimals: 2, buyable: true }));
    const base: RiskInput = {
      spec: { markets: ["*"], risk: { maxPositionBps: 10000, maxTradeBps: 10000, maxDailyLossBps: 10000, maxTradesPerDay: 1, durationDays: 0 } },
      preset: { allowsBuy: true, allowsSell: true },
      markets,
      balances: { usdc: 0, tokens: Object.fromEntries(syms.map((s) => [s, 10])) },
      mids: Object.fromEntries(syms.map((s) => [s, 10])),
      tradesToday: 5,
      dailyPnlBps: 0,
      decision: { note: "", actions: syms.map((s) => ({ type: "sell" as const, market: s, sizeBps: 10000, reason: "stop" })) },
    };
    expect(evaluateDecision(base, { protective: true }).orders).toHaveLength(5);
    const ai = evaluateDecision({ ...base, tradesToday: 0, spec: { ...base.spec, risk: { ...base.spec.risk, maxTradesPerDay: 50 } } });
    expect(ai.orders).toHaveLength(3);
    expect(ai.rejections.map((r) => r.code)).toEqual(["too_many_actions", "too_many_actions"]);
  });
});
