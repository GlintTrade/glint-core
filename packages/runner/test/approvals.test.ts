// Lighter checks before an agent trades, and the platform fee of an order.
import { MemoryLighterKeyStore } from "@glint/lighter";
import { PRESETS, type StrategySpec } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { checkLighterApprovals, feeModeOf, integratorForOrder, NO_INTEGRATOR, platformFeeOn } from "../src/approvals.js";
import { loadIntegratorConfig } from "../src/config.js";
import { agentUniverse } from "../src/universe.js";
import { addAgent, HL_ACC, INTEGRATOR, INTEGRATOR_CONFIG, makeWorld } from "./helpers.js";

const dca = PRESETS.find((p) => p.key === "dca")!;
const spec: StrategySpec = {
  version: 1,
  preset: "dca",
  name: "DCA SPY",
  goal: "",
  markets: ["SPY"],
  quote: "USDG",
  model: "model-a",
  intervalSec: 300,
  profile: "balanced",
  risk: dca.defaults.balanced.risk,
  params: dca.defaults.balanced.params,
};

describe("checkLighterApprovals", () => {
  it("registered key + approved integrator -> no problems, the approval limits are returned", async () => {
    const w = await makeWorld();
    const k = addAgent(w, { id: 1, spec });
    const st = await checkLighterApprovals(w.exchange, w.keyRows, HL_ACC, k.apiWallet, INTEGRATOR_CONFIG, Math.floor(Date.now() / 1000));
    expect(st.problems).toEqual([]);
    expect(st.integrator).toMatchObject({ approved: true, maxSpotTakerFee: 1000 });
  });

  it("unknown key, another account, unregistered key, missing integrator approval", async () => {
    const w = await makeWorld();
    const now = Math.floor(Date.now() / 1000);
    const k = addAgent(w, { id: 1, spec, register: false, integrator: false });
    expect((await checkLighterApprovals(w.exchange, new MemoryLighterKeyStore(), HL_ACC, k.apiWallet, INTEGRATOR_CONFIG, now)).problems).toEqual([
      "lighter_key_unknown",
    ]);
    const other = "0x00000000000000000000000000000000000000f9";
    expect((await checkLighterApprovals(w.exchange, w.keyRows, other, k.apiWallet, INTEGRATOR_CONFIG, now)).problems).toEqual(["lighter_account_mismatch"]);
    expect((await checkLighterApprovals(w.exchange, w.keyRows, HL_ACC, k.apiWallet, INTEGRATOR_CONFIG, now)).problems).toEqual([
      "lighter_key_not_registered",
      "lighter_integrator_not_approved",
    ]);
    // without a platform fee the integrator is not checked at all
    expect((await checkLighterApprovals(w.exchange, w.keyRows, HL_ACC, k.apiWallet, NO_INTEGRATOR, now)).problems).toEqual(["lighter_key_not_registered"]);
  });
});

describe("platform fee", () => {
  const approved = { approved: true, maxSpotTakerFee: 1000, maxSpotMakerFee: 1000, expiresAt: Date.now() + 1e9 };

  it("fee modes: disabled, no approval, standard tier, charged", () => {
    expect(platformFeeOn(NO_INTEGRATOR)).toBe(false);
    expect(feeModeOf(NO_INTEGRATOR, true, "plus")).toBe("disabled");
    expect(feeModeOf(INTEGRATOR_CONFIG, false, "plus")).toBe("zero_fee_no_approval");
    expect(feeModeOf(INTEGRATOR_CONFIG, true, "standard")).toBe("zero_fee_standard_tier");
    expect(feeModeOf(INTEGRATOR_CONFIG, true, null)).toBe("zero_fee_standard_tier");
    expect(feeModeOf(INTEGRATOR_CONFIG, true, "premium")).toBe("charged");
  });

  it("order fields: attribution with a valid approval, the fee capped by the approved maximum", () => {
    expect(integratorForOrder(INTEGRATOR_CONFIG, approved, "plus").fields).toEqual({ accountIndex: INTEGRATOR, takerFee: 100, makerFee: 0 });
    expect(integratorForOrder(INTEGRATOR_CONFIG, { ...approved, maxSpotTakerFee: 40 }, "plus").fields?.takerFee).toBe(40);
    expect(integratorForOrder(INTEGRATOR_CONFIG, approved, "standard").fields).toEqual({ accountIndex: INTEGRATOR, takerFee: 0, makerFee: 0 });
    expect(integratorForOrder(INTEGRATOR_CONFIG, { ...approved, approved: false }, "plus").fields).toBeUndefined();
  });

  it("loadIntegratorConfig: empty env -> none; validation of the account index and fee caps", () => {
    expect(loadIntegratorConfig({})).toEqual({ accountIndex: null, spotTakerFee: 0, spotMakerFee: 0, required: true });
    expect(
      loadIntegratorConfig({ LIGHTER_INTEGRATOR_ACCOUNT_INDEX: "777", LIGHTER_INTEGRATOR_SPOT_TAKER_FEE: "100", LIGHTER_INTEGRATOR_REQUIRED: "false" }),
    ).toEqual({
      accountIndex: 777,
      spotTakerFee: 100,
      spotMakerFee: 0,
      required: false,
    });
    expect(() => loadIntegratorConfig({ LIGHTER_INTEGRATOR_ACCOUNT_INDEX: "-1" })).toThrow(/positive integer/);
    expect(() => loadIntegratorConfig({ LIGHTER_INTEGRATOR_ACCOUNT_INDEX: "1", LIGHTER_INTEGRATOR_SPOT_TAKER_FEE: "30000" })).toThrow(/0\.\.20000/);
    expect(() => loadIntegratorConfig({ LIGHTER_INTEGRATOR_SPOT_TAKER_FEE: "100" })).toThrow(/needs LIGHTER_INTEGRATOR_ACCOUNT_INDEX/);
  });
});

describe("market sync and closed markets", () => {
  it("pairs are enabled automatically by 24h volume; a pinned market keeps its state across syncs", async () => {
    const w = await makeWorld();
    const bySym = () => Object.fromEntries(w.store.listMarkets().map((m) => [m.symbol, m]));
    expect(bySym().NVDA?.enabled).toBe(true);
    w.exchange.markets = w.exchange.markets.map((m) => (m.pair === "NVDA/USDG" ? { ...m, dayQuoteVolume: 10 } : m));
    await w.runner.refreshMarkets();
    expect(bySym().NVDA?.enabled).toBe(false); // below the 5000 USDG threshold
    w.store.setMarketEnabled("NVDA", true);
    await w.runner.refreshMarkets();
    expect(bySym().NVDA?.enabled).toBe(true); // pinned
    expect(Object.keys(bySym()).sort()).toEqual(["NVDA", "SPY"]); // the non-USDG row is ignored
  });

  it("agentUniverse: a closed selected market stays sellable with buyable=false; '*' leaves closed markets out", async () => {
    const w = await makeWorld();
    const all = w.store.listMarkets();
    const isOpen = (m: { symbol: string }) => m.symbol !== "SPY";
    const sel = agentUniverse(["SPY", "NVDA"], all, [], 5, () => true, isOpen);
    expect(sel.find((m) => m.symbol === "SPY")).toMatchObject({ buyable: false, unbuyableReason: "closed" });
    expect(sel.find((m) => m.symbol === "NVDA")?.buyable).toBe(true);
    const star = agentUniverse(["*"], all, [], 5, () => true, isOpen);
    expect(star.map((m) => m.symbol)).toEqual(["NVDA"]);
  });
});
