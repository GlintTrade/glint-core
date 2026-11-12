import { keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  ALL_MARKETS,
  canonicalJson,
  durationWords,
  formatParamValue,
  isAllMarkets,
  type ModelInfo,
  marketsWords,
  modelIdOf,
  PRESETS,
  riskWords,
  type StrategySpec,
  specHashOf,
  type ValidationEnv,
  validateSpec,
} from "../src/index.js";

const dca = PRESETS.find((p) => p.key === "dca")!;
const trend = PRESETS.find((p) => p.key === "trend")!;
const rebalance = PRESETS.find((p) => p.key === "rebalance")!;

const MODELS: ModelInfo[] = [
  { id: "standard-model", label: "Standard", provider: "openai-compatible", tier: "standard", enabled: true },
  { id: "premium-model", label: "Premium", provider: "openai-compatible", tier: "premium", enabled: true },
  { id: "off-model", label: "Off", provider: "openai-compatible", tier: "standard", enabled: false },
];
const env: ValidationEnv = { presets: PRESETS, marketSymbols: ["NVDA", "SPY"], models: MODELS, intervals: { min: 300, premiumMin: 60 }, isPremium: false };

const dcaSpec: StrategySpec = {
  version: 1,
  preset: "dca",
  name: "Accumulator",
  goal: "accumulate NVDA on dips",
  markets: ["NVDA"],
  quote: "USDG",
  model: "standard-model",
  intervalSec: 300,
  profile: "balanced",
  risk: dca.defaults.balanced.risk,
  params: dca.defaults.balanced.params,
};

const trendSpec = (markets: string[]): StrategySpec => ({
  ...dcaSpec,
  preset: "trend",
  name: "Trend",
  markets,
  risk: trend.defaults.balanced.risk,
  params: trend.defaults.balanced.params,
});

describe("canonical specHash", () => {
  it("specHash = keccak256(toBytes(canonicalJson(spec)))", () => {
    expect(specHashOf(dcaSpec)).toBe(keccak256(toBytes(canonicalJson(dcaSpec))));
  });
  it("is independent of key order, ignores undefined fields, depends on content", () => {
    const { params, risk, ...rest } = dcaSpec;
    const shuffled = JSON.parse(JSON.stringify({ params, risk, ...rest }));
    expect(specHashOf(shuffled)).toBe(specHashOf(dcaSpec));
    expect(specHashOf({ ...dcaSpec, extra: undefined } as unknown as StrategySpec)).toBe(specHashOf(dcaSpec));
    expect(specHashOf({ ...dcaSpec, name: "other" })).not.toBe(specHashOf(dcaSpec));
  });
  it("canonicalJson: sorted keys, no whitespace, UTF-8 preserved", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: "ü" }] })).toBe('{"a":[2,{"c":"ü","d":1}],"b":1}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
  it("modelId = keccak256(utf8(model))", () => {
    expect(modelIdOf("some-model")).toBe(keccak256(toBytes("some-model")));
  });
});

describe("validateSpec", () => {
  it("accepts built-in defaults for every preset and profile", () => {
    for (const p of PRESETS) {
      for (const profile of ["conservative", "balanced", "aggressive"] as const) {
        const d = p.defaults[profile];
        const markets = p.rules?.rebalance ? Object.keys(d.params[p.rules.rebalance.targetsParam] as Record<string, number>) : ["NVDA"];
        const s: StrategySpec = { ...dcaSpec, preset: p.key, profile, markets, risk: d.risk, params: d.params };
        expect(validateSpec(s, env), `${p.key}/${profile}`).toMatchObject({ ok: true, errors: [] });
      }
    }
  });

  it("returns the specHash alongside the result", () => {
    expect(validateSpec(dcaSpec, env).specHash).toBe(specHashOf(dcaSpec));
  });

  it("rejects extra keys (they would change the specHash) and malformed structure", () => {
    expect(validateSpec({ ...dcaSpec, extra: 1 }, env).ok).toBe(false);
    expect(validateSpec({ ...dcaSpec, risk: { ...dcaSpec.risk, maxTradeBps: 0 } }, env).ok).toBe(false);
    expect(validateSpec({ ...dcaSpec, quote: "USDT" }, env).ok).toBe(false);
    expect(validateSpec(null, env)).toMatchObject({ ok: false, specHash: null });
  });

  it('["*"] is valid alone; mixed with symbols it is an error; selected pairs must be whitelisted', () => {
    expect(validateSpec(trendSpec([ALL_MARKETS]), env)).toMatchObject({ ok: true });
    expect(validateSpec(trendSpec([ALL_MARKETS, "NVDA"]), env).errors.some((e) => e.includes("only element"))).toBe(true);
    expect(validateSpec(trendSpec(["DOGE"]), env).ok).toBe(false);
    expect(validateSpec(trendSpec(["NVDA", "NVDA"]), env).errors.some((e) => e.includes("duplicate"))).toBe(true);
    expect(validateSpec(trendSpec(["NVDA", "SPY"]), env).ok).toBe(true);
  });

  it("models: disabled is unavailable, premium needs premium status", () => {
    expect(validateSpec({ ...dcaSpec, model: "off-model" }, env).ok).toBe(false);
    expect(validateSpec({ ...dcaSpec, model: "premium-model" }, env).errors.some((e) => e.startsWith("model"))).toBe(true);
    expect(validateSpec({ ...dcaSpec, model: "premium-model" }, { ...env, isPremium: true }).ok).toBe(true);
  });

  it("intervals: 60 s only for premium, max one day", () => {
    expect(validateSpec({ ...dcaSpec, intervalSec: 60 }, env).ok).toBe(false);
    expect(validateSpec({ ...dcaSpec, intervalSec: 60 }, { ...env, isPremium: true }).ok).toBe(true);
    expect(validateSpec({ ...dcaSpec, intervalSec: 86401 }, env).ok).toBe(false);
  });

  it("params follow the preset paramsSchema", () => {
    const errs = (params: StrategySpec["params"]) => validateSpec({ ...dcaSpec, params }, env).errors;
    expect(errs({ buyEverySec: 3600 })).toEqual(["params.budgetPerBuyBps: required"]);
    expect(errs({ buyEverySec: 10, budgetPerBuyBps: 500 })[0]).toContain("below the minimum");
    expect(errs({ buyEverySec: "x", budgetPerBuyBps: 500 })[0]).toContain("expected a number");
    const t = (timeframe: string) => validateSpec({ ...trendSpec(["NVDA"]), params: { ...trend.defaults.balanced.params, timeframe } }, env).ok;
    expect(t("4h")).toBe(true);
    expect(t("2h")).toBe(false);
  });

  it("rebalance: weights are validated and target tokens must be agent markets", () => {
    const rb = (markets: string[], targets: Record<string, number>) =>
      validateSpec(
        { ...dcaSpec, preset: "rebalance", markets, risk: rebalance.defaults.balanced.risk, params: { ...rebalance.defaults.balanced.params, targets } },
        env,
      );
    expect(rb(["NVDA"], { NVDA: 5000 }).ok).toBe(true);
    expect(rb(["NVDA"], { NVDA: 5000, SPY: 2000 }).errors.some((e) => e.includes("must be one of the agent's markets"))).toBe(true);
    expect(rb(["NVDA", "SPY"], { NVDA: 6000, SPY: 5000 }).errors.some((e) => e.includes("> 10000"))).toBe(true);
    expect(rb([ALL_MARKETS], { NVDA: 5000 }).errors.some((e) => e.includes("needs explicit pairs"))).toBe(true);
  });
});

describe("units", () => {
  it("isAllMarkets", () => {
    expect(isAllMarkets(["*"])).toBe(true);
    expect(isAllMarkets(["*", "NVDA"])).toBe(false);
    expect(isAllMarkets(undefined)).toBe(false);
  });
  it("formats params in human units", () => {
    expect(formatParamValue({ key: "budgetPerBuyBps", type: "number" }, 500)).toBe("5%");
    expect(formatParamValue({ key: "buyEverySec", type: "number" }, 21600)).toBe("6 hours");
    expect(formatParamValue({ key: "stopLossPct", type: "number" }, 7)).toBe("7%");
    expect(formatParamValue({ key: "targets", type: "weights" }, { NVDA: 5000, SPY: 3000 })).toBe("NVDA 50%, SPY 30% (20% stays in USDG)");
    expect(durationWords(90)).toBe("1.5 minutes");
    expect(durationWords(129600)).toBe("36 hours");
    expect(durationWords(259200)).toBe("3 days");
  });
  it("describes risk and markets", () => {
    expect(riskWords(dca.defaults.balanced.risk)).toContain("at most 60% of capital in one token");
    expect(marketsWords(["*"])).toBe("any enabled liquid pair");
    expect(marketsWords(["NVDA", "SPY"])).toBe("NVDA, SPY");
  });
});
