// Rebalance preset in the loop: the code computes the plan; the AI is called only when a token drifts beyond the band.
import { PRESETS, type RiskBox, type StrategySpec } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { lc } from "../src/types.js";
import { addAgent, FakeProvider, HL_ACC, makeWorld } from "./helpers.js";

const rebalance = PRESETS.find((p) => p.key === "rebalance")!;
const risk: RiskBox = { maxPositionBps: 9000, maxTradeBps: 9000, maxDailyLossBps: 2000, maxTradesPerDay: 20, durationDays: 0 };

describe("runner: Rebalance calls the AI only on drift and passes codePlan", () => {
  async function setup(tokens: { coin: string; total: number }[], usdc: number) {
    const now = Math.floor(Date.now() / 1000);
    const primary = new FakeProvider("primary");
    const w = await makeWorld({ primary, now: () => now });
    const spec: StrategySpec = {
      version: 1,
      preset: rebalance.key,
      name: "rb",
      goal: "",
      markets: ["NVDA"],
      quote: "USDG",
      model: "model-a",
      intervalSec: 300,
      profile: "balanced",
      risk,
      params: { targets: { NVDA: 5000 }, driftBandBps: 500, minRebalanceSec: 0, maxRebalanceTradeBps: 9000 },
    };
    addAgent(w, { id: 1, spec, owner: HL_ACC, createdAt: now - 100, allocationUsd: null });
    w.exchange.balances.set(lc(HL_ACC), [{ coin: "USDG", total: usdc, hold: 0, entryNtl: 0 }, ...tokens.map((t) => ({ ...t, hold: 0, entryNtl: 0 }))]);
    return w;
  }

  it("within the band -> no_trigger, the AI is not called", async () => {
    const t = await setup([{ coin: "NVDA", total: 12.5 }], 500); // NVDA 500 / 1000 = 5000 bps
    expect((await t.runner.tickAgent(t.store.getAgent(1)!)).kind).toBe("no_trigger");
    expect(t.primary.calls).toHaveLength(0);
  });

  it("drift -> the AI gets codePlan, executes it, and the sell carries the platform partner fields", async () => {
    const t = await setup([{ coin: "NVDA", total: 17.5 }], 300); // NVDA 7000 bps -> sell ~2857 bps of the position
    t.primary.queue.push(JSON.stringify({ actions: [{ type: "sell", market: "NVDA", sizeBps: 2857, limitPriceUsd: null, reason: "rebalance" }], note: "ok" }));
    const out = await t.runner.tickAgent(t.store.getAgent(1)!);
    expect(out.kind).toBe("decided");
    expect(t.primary.calls[0]!.user).toContain("codePlan");
    expect(t.primary.calls[0]!.system).toContain("codePlan");
    expect(t.exchange.orders).toHaveLength(1);
    expect(t.exchange.orders[0]!.order.isBuy).toBe(false);
    expect(t.exchange.orders[0]!.order.integrator).toBeDefined();
  });
});
