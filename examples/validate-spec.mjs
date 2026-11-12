// Validate a strategy spec and compute the specHash that AgentHub stores.
// Run after `npm run build`:  node examples/validate-spec.mjs
import { PRESETS, specHashOf, validateSpec } from "@glint/strategy";

const trend = PRESETS.find((p) => p.key === "trend");

const spec = {
  version: 1,
  preset: "trend",
  name: "NVDA + SPY trend",
  goal: "Ride confirmed uptrends in NVDA and SPY, move to USDG on reversals. Preserve capital first.",
  markets: ["NVDA", "SPY"],
  quote: "USDG",
  model: "example-model",
  intervalSec: 300,
  profile: "conservative",
  risk: trend.defaults.conservative.risk,
  params: trend.defaults.conservative.params,
};

const env = {
  presets: PRESETS,
  marketSymbols: ["NVDA", "SPY", "QQQ", "AMD", "TSLA"],
  models: [{ id: "example-model", label: "Example", provider: "primary", tier: "standard", enabled: true }],
  intervals: { min: 300, premiumMin: 60 },
  isPremium: false,
};

const ok = validateSpec(spec, env);
console.log("valid spec      ->", { ok: ok.ok, errors: ok.errors, specHash: specHashOf(spec) });

const broken = { ...spec, markets: ["NVDA", "DOGE"], intervalSec: 60, risk: { ...spec.risk, maxTradeBps: 0 } };
const bad = validateSpec(broken, env);
console.log("broken spec     ->", { ok: bad.ok, errors: bad.errors });

const fixed = { ...broken, risk: spec.risk };
console.log("after one fix   ->", validateSpec(fixed, env).errors);
