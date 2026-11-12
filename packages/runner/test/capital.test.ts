// Agent capital: sub-accounts on a shared Lighter account.
import { PRESETS, type StrategySpec } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { type CapitalParticipant, capitalView, ledgerFromTrades, unallocatedUsdc } from "../src/capital/ledger.js";
import { allocationError, unallocatedOnAccount } from "../src/capital/service.js";
import { lc } from "../src/types.js";
import { addAgent, FakeProvider, HL_ACC, makeWorld } from "./helpers.js";

const buy = (market: string, usd: number, qty: number) => ({ side: "buy" as const, market, sizeUsd: usd, sizeBase: qty });
const sell = (market: string, usd: number, qty: number) => ({ side: "sell" as const, market, sizeUsd: usd, sizeBase: qty });
const part = (o: Partial<CapitalParticipant> & { agentId: number }): CapitalParticipant => ({
  allocationUsd: 0,
  trades: [],
  buys: true,
  running: true,
  reserving: true,
  ...o,
});

describe("ledgerFromTrades", () => {
  it("allocation - buys + sells; tokens and average entry; realized PnL", () => {
    const l = ledgerFromTrades(100, [buy("NVDA", 40, 1), buy("NVDA", 44, 1), sell("NVDA", 50, 1)]);
    expect(l.usdc).toBeCloseTo(100 - 40 - 44 + 50, 9);
    expect(l.tokens.NVDA).toBeCloseTo(1, 9);
    expect(l.avgEntry.NVDA).toBeCloseTo(42, 9);
    expect(l.realizedPnlUsd).toBeCloseTo(50 - 42, 9);
  });
  it("selling more than its own (adopted tokens) never drives the quantity negative", () => {
    const l = ledgerFromTrades(0, [sell("SLV", 11, 2.6)]);
    expect(l.tokens.SLV ?? 0).toBe(0);
    expect(l.usdc).toBeCloseTo(11, 9);
  });
});

describe("capitalView: two agents on one Lighter account", () => {
  const real = { usdc: 50, tokens: {} as Record<string, number> };
  it("each sees only its own USDG", () => {
    const a = capitalView({
      self: { ...part({ agentId: 1, allocationUsd: 20 }), manageExistingHoldings: false },
      others: [part({ agentId: 2, allocationUsd: 30 })],
      real,
    });
    const b = capitalView({
      self: { ...part({ agentId: 2, allocationUsd: 30 }), manageExistingHoldings: false },
      others: [part({ agentId: 1, allocationUsd: 20 })],
      real,
    });
    expect(a.ok && a.usdc).toBe(20);
    expect(b.ok && b.usdc).toBe(30);
  });
  it("tokens bought by agent B are invisible to agent A, which cannot sell them", () => {
    const realT = { usdc: 38.5, tokens: { NVDA: 0.3 } };
    const a = capitalView({
      self: { ...part({ agentId: 1, allocationUsd: 20 }), manageExistingHoldings: false },
      others: [part({ agentId: 2, allocationUsd: 30, trades: [buy("NVDA", 11.5, 0.3)] })],
      real: realT,
    });
    expect(a.ok && a.tokens.NVDA).toBeUndefined();
    expect(a.ok && a.usdc).toBeCloseTo(20, 9);
    const b = capitalView({
      self: { ...part({ agentId: 2, allocationUsd: 30, trades: [buy("NVDA", 11.5, 0.3)] }), manageExistingHoldings: false },
      others: [part({ agentId: 1, allocationUsd: 20 })],
      real: realT,
    });
    expect(b.ok && b.tokens.NVDA).toBeCloseTo(0.3, 9);
    expect(b.ok && b.usdc).toBeCloseTo(18.5, 9);
  });
  it("reconciliation: real balance below the sum of ledgers -> shares scale down, never spend more than exists", () => {
    const r = capitalView({
      self: { ...part({ agentId: 1, allocationUsd: 20 }), manageExistingHoldings: false },
      others: [part({ agentId: 2, allocationUsd: 30 })],
      real: { usdc: 40, tokens: {} },
    });
    expect(r.ok && r.usdc).toBeCloseTo(16, 9); // 40 * 20/50
    expect(r.ok && r.scaledDown).toEqual(["USDG"]);
  });
  it("Lighter fee in the received token (received less than bought) -> own quantity capped by the real balance", () => {
    const r = capitalView({
      self: { ...part({ agentId: 1, allocationUsd: 20, trades: [buy("SLV", 11.44, 2.6)] }), manageExistingHoldings: false },
      others: [],
      real: { usdc: 8.56, tokens: { SLV: 2.598253 } },
    });
    expect(r.ok && r.tokens.SLV).toBeCloseTo(2.598253, 9);
    // a fee-sized gap (~0.07%) is not reported as "scaled down" (it would log on every tick: production finding)
    expect(r.ok && r.scaledDown).toEqual([]);
  });
});

describe("capitalView: Protect (manageExistingHoldings)", () => {
  it("adopts tokens no active agent owns (manual buys or a stopped agent)", () => {
    const r = capitalView({
      self: { ...part({ agentId: 3, allocationUsd: null, buys: false }), manageExistingHoldings: true },
      others: [part({ agentId: 2, allocationUsd: null, running: false, reserving: false, trades: [buy("SLV", 11.44, 2.6)] })], // stopped DCA
      real: { usdc: 8, tokens: { SLV: 2.598253, NVDA: 0.2 } },
    });
    expect(r.ok && r.mode).toBe("ledger");
    expect(r.ok && r.tokens.SLV).toBeCloseTo(2.598253, 9);
    expect(r.ok && r.adopted).toMatchObject({ SLV: 2.598253, NVDA: 0.2 });
    expect(r.ok && r.usdc).toBe(0); // Protect never spends other agents' USDG
  });
  it("does NOT adopt tokens of a paused agent (a pause does not hand positions to another agent)", () => {
    const r = capitalView({
      self: { ...part({ agentId: 3, allocationUsd: null, buys: false }), manageExistingHoldings: true },
      others: [part({ agentId: 2, allocationUsd: 30, running: false, reserving: true, trades: [buy("NVDA", 13.4, 0.17)] })], // paused Trend
      real: { usdc: 0, tokens: { NVDA: 0.1699 } },
    });
    expect(r.ok && r.tokens.NVDA).toBeUndefined();
    expect(r.ok && r.adopted.NVDA).toBeUndefined();
  });
  it("does NOT touch tokens of a running agent", () => {
    const r = capitalView({
      self: { ...part({ agentId: 3, allocationUsd: null, buys: false }), manageExistingHoldings: true },
      others: [part({ agentId: 2, allocationUsd: 30, running: true, trades: [buy("NVDA", 12, 0.3)] })],
      real: { usdc: 18, tokens: { NVDA: 0.5 } },
    });
    expect(r.ok && r.tokens.NVDA).toBeCloseTo(0.2, 9); // 0.5 - 0.3 of the running DCA
    expect(r.ok && r.adopted.NVDA).toBeCloseTo(0.2, 9);
  });
});

describe("capitalView: legacy agents without an allocation", () => {
  it("the only agent on the account -> whole account (legacy behaviour)", () => {
    const r = capitalView({
      self: { ...part({ agentId: 1, allocationUsd: null }), manageExistingHoldings: false },
      others: [],
      real: { usdc: 19.5, tokens: { SLV: 2 } },
    });
    expect(r.ok && r.mode).toBe("whole_account");
    expect(r.ok && r.usdc).toBe(19.5);
    expect(r.ok && r.tokens.SLV).toBe(2);
  });
  it("with other agents on the account -> allocation_required (for an agent that buys)", () => {
    const r = capitalView({
      self: { ...part({ agentId: 1, allocationUsd: null }), manageExistingHoldings: false },
      others: [part({ agentId: 2, allocationUsd: 20 })],
      real: { usdc: 50, tokens: {} },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("allocation_required");
  });
});

describe("unallocatedUsdc", () => {
  it("unallocated = free USDG - ledgers of reserving agents; a running whole-account agent -> 0", () => {
    expect(
      unallocatedUsdc(50, [part({ agentId: 1, allocationUsd: 20 }), part({ agentId: 2, allocationUsd: 10, running: false, reserving: false })]).unallocated,
    ).toBe(30);
    expect(unallocatedUsdc(50, [part({ agentId: 1, allocationUsd: null })])).toMatchObject({ unallocated: 0, wholeAccountAgentId: 1 });
  });
});

// ---------- integration with the runner ----------

const dca = PRESETS.find((p) => p.key === "dca")!;
const protect = PRESETS.find((p) => p.key === "protect")!;
const specOf = (preset: "dca" | "protect", markets = ["NVDA"]): StrategySpec => {
  const p = preset === "dca" ? dca : protect;
  return {
    version: 1,
    preset,
    name: preset,
    goal: "",
    markets,
    quote: "USDG",
    model: "model-a",
    intervalSec: 300,
    profile: "balanced",
    risk: p.defaults.balanced.risk,
    params: p.defaults.balanced.params,
  };
};

async function world() {
  const w = await makeWorld({ primary: new FakeProvider("primary") });
  const add = (id: number, preset: "dca" | "protect", allocationUsd: number | null, chainStatus = 0) =>
    addAgent(w, { id, spec: specOf(preset), allocationUsd, chainStatus, owner: HL_ACC });
  const trade = (agentId: number, market: string, usd: number, qty: number) =>
    w.store.insertTrade({
      agentId,
      owner: HL_ACC,
      side: "buy",
      market,
      sizeUsd: usd,
      sizeBase: qty,
      price: usd / qty,
      reason: "t",
      hlOrderId: 1,
      timestamp: 10,
      platformFeeUsd: 0,
      source: "llm",
    });
  return { ...w, add, trade };
}

describe("runner.snapshot: the agent sub-account", () => {
  it("two DCA agents on one account split USDG by allocation; B's tokens are invisible to A", async () => {
    const w = await world();
    w.add(1, "dca", 20);
    w.add(2, "dca", 30);
    w.trade(2, "NVDA", 12, 0.3);
    w.exchange.balances.set(lc(HL_ACC), [
      { coin: "USDG", total: 38, hold: 0, entryNtl: 0 },
      { coin: "NVDA", total: 0.3, hold: 0, entryNtl: 12 },
    ]);
    const s1 = await w.runner.snapshot(w.store.getAgent(1)!, specOf("dca"));
    const s2 = await w.runner.snapshot(w.store.getAgent(2)!, specOf("dca"));
    expect(s1.balances.usdc).toBeCloseTo(20, 9);
    expect(s1.balances.tokens.NVDA ?? 0).toBe(0);
    expect(s2.balances.usdc).toBeCloseTo(18, 9);
    expect(s2.balances.tokens.NVDA).toBeCloseTo(0.3, 9);
    expect(s1.equity).toBeCloseTo(20, 6);
    expect(s2.equity).toBeCloseTo(18 + 0.3 * 40, 6);
  });

  it("an agent without an allocation while other agents share the account -> paused with allocation_required", async () => {
    const w = await world();
    w.add(1, "dca", null);
    w.add(2, "dca", 30);
    w.exchange.balances.set(lc(HL_ACC), [{ coin: "USDG", total: 50, hold: 0, entryNtl: 0 }]);
    const out = await w.runner.tickAgent(w.store.getAgent(1)!);
    expect(out).toEqual({ kind: "skipped", reason: "allocation_required" });
    expect(w.store.getAgent(1)!.offchainStatus).toBe("paused");
    expect(w.store.getAgent(1)!.pauseReason).toMatch(/^allocation_required/);
  });

  it("Protect without an allocation guards the tokens of a stopped agent and records the adoption", async () => {
    const w = await world();
    w.add(2, "dca", null, 2); // DCA stopped on-chain
    w.add(3, "protect", null);
    w.trade(2, "NVDA", 12, 0.3);
    w.exchange.balances.set(lc(HL_ACC), [
      { coin: "USDG", total: 8, hold: 0, entryNtl: 0 },
      { coin: "NVDA", total: 0.3, hold: 0, entryNtl: 12 },
    ]);
    const s = await w.runner.snapshot(w.store.getAgent(3)!, specOf("protect"));
    expect(s.balances.tokens.NVDA).toBeCloseTo(0.3, 9);
    expect(s.balances.usdc).toBe(0);
    expect(s.capital?.ok && s.capital.adopted.NVDA).toBeCloseTo(0.3, 9);
  });
});

describe("day baseline of a new Protect agent with adopted tokens (production regression)", () => {
  it("first tick: dayStart = equity including guarded tokens, no double shift", async () => {
    const w = await world();
    w.add(2, "dca", null, 2); // stopped
    w.add(3, "protect", null);
    w.trade(2, "NVDA", 12, 0.3);
    w.exchange.balances.set(lc(HL_ACC), [
      { coin: "USDG", total: 8, hold: 0, entryNtl: 0 },
      { coin: "NVDA", total: 0.3, hold: 0, entryNtl: 12 },
    ]);
    await w.runner.tickAgent(w.store.getAgent(3)!);
    const st = w.store.getAgent(3)!.state;
    const mid = (await w.runner.midsBySymbol()).NVDA!;
    expect(st.dayStart?.equity).toBeCloseTo(0.3 * mid, 6);
    expect(st.initialEquity).toBeCloseTo(0.3 * mid, 6);
    expect(w.store.getCapital(3)?.adopted.NVDA).toBeCloseTo(0.3, 9);
  });
});

describe("capital service", () => {
  it("a never-buy agent reserves no USDG even with a stored allocation (left over from a buying preset)", async () => {
    const w = await world();
    w.add(1, "protect", 11.47);
    w.exchange.balances.set(lc(HL_ACC), [{ coin: "USDG", total: 20, hold: 0, entryNtl: 0 }]);
    const u = await unallocatedOnAccount(w.store, w.exchange, HL_ACC);
    expect(u.allocated).toBe(0);
    expect(u.unallocated).toBeCloseTo(20, 9);
  });

  it("allocationError: required, too small, account in use, above the unallocated USDG; sell-only presets need none", () => {
    const cap = { minAgentCapitalUsd: 10, minOrderUsd: 10, unallocatedUsd: 50, wholeAccountAgentId: null };
    expect(allocationError(cap, null, false)).toBeNull();
    expect(allocationError(cap, null, true)?.code).toBe("allocation_required");
    expect(allocationError(cap, 5, true)?.code).toBe("allocation_too_small");
    expect(allocationError({ ...cap, wholeAccountAgentId: 7 }, 20, true)?.code).toBe("account_in_use");
    expect(allocationError(cap, 60, true)?.code).toBe("allocation_exceeds_free");
    expect(allocationError(cap, 50, true)).toBeNull();
  });
});
