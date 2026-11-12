# @glint/strategy

The strategy layer of Glint: what an agent is allowed to do, expressed as data.

- **`StrategySpec`**: preset, markets, plain-language goal, AI model, decision interval, risk profile, hard risk
  limits (`RiskBox`, all shares in bps) and preset parameters.
- **Validation** (`validateSpec`): strict structure (zod, no unknown keys) plus semantics: preset enabled, markets
  whitelisted (or `["*"]` alone), model available, interval allowed, params within the preset `paramsSchema`,
  rebalance targets consistent with the markets.
- **Canonical hashing** (`canonicalJson`, `specHashOf`, `modelIdOf`): `specHash = keccak256(canonical JSON)` is what
  the AgentHub contract stores. Key order and `undefined` fields never change the hash; any content change does.
- **Built-in presets** (`PRESETS`): DCA, Protect, Trend, Rebalance, Momentum. A preset is data: indicators, a prompt
  template, code-enforced rules (`rules`) and protective stops (`protection`). No code branches on a preset key.
- **Units** (`formatParamValue`, `riskWords`, `durationWords`): bps and seconds shown as percent and durations.
- **Chains** (`CHAINS`, `DEPLOYMENTS`, `ERC8004`): Robinhood Chain networks, the AgentHub address, USDG and the
  ERC-8004 Identity Registry.
- **Quote**: specs are quoted in USDG. `"USDC"` from older clients is accepted and normalised to `"USDG"` before
  hashing.

```ts
import { PRESETS, specHashOf, validateSpec } from "@glint/strategy";

const trend = PRESETS.find((p) => p.key === "trend")!;
const spec = {
  version: 1,
  preset: "trend",
  name: "NVDA trend",
  goal: "Ride confirmed uptrends, exit on reversals.",
  markets: ["NVDA"],
  quote: "USDG",
  model: "my-model",
  intervalSec: 300,
  profile: "balanced",
  risk: trend.defaults.balanced.risk,
  params: trend.defaults.balanced.params,
};

const res = validateSpec(spec, {
  presets: PRESETS,
  marketSymbols: ["NVDA", "SPY"],
  models: [{ id: "my-model", label: "My model", provider: "primary", tier: "standard", enabled: true }],
  intervals: { min: 300, premiumMin: 60 },
  isPremium: false,
});
console.log(res.ok, res.errors, specHashOf(spec));
```

## License

BUSL-1.1, see [LICENSE](./LICENSE).
