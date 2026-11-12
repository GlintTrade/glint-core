// Reference text for the model: StrategySpec format, limits, spot rules, an example.
// Built-in presets come from ./spec.ts; live presets (paramsSchema, defaults per profile) always come from list_presets.

import { BUILTIN_PRESETS, type BuiltinPreset, DEFAULT_INTERVAL_SEC, DEFAULT_MARKET_SYMBOLS, LIMITS, type StrategySpec } from "./spec";

function exampleSpec(): StrategySpec {
  return {
    version: 1,
    preset: "trend",
    name: "NVDA+SPY trend (conservative)",
    goal: "Ride confirmed uptrends in NVDA and SPY, go back to USDG on reversals. Preserve capital first; skip choppy markets.",
    markets: ["NVDA", "SPY"],
    quote: "USDG",
    model: "<model id from list_models>",
    intervalSec: DEFAULT_INTERVAL_SEC,
    profile: "conservative",
    risk: { maxPositionBps: 3000, maxTradeBps: 1500, maxDailyLossBps: 300, maxTradesPerDay: 6, durationDays: 30 },
    params: { timeframe: "4h", fastEma: 20, slowEma: 50, stopLossPct: 5 },
  };
}

function presetKeysText(): string {
  return BUILTIN_PRESETS.map((p) => JSON.stringify(p.key)).join(" | ");
}

function presetRight(p: BuiltinPreset): string {
  if (p.allowsBuy && p.allowsSell) return "buy and sell, long only";
  if (p.allowsBuy) return "buy only";
  if (p.allowsSell) return "sell only (protects existing holdings, needs no capital)";
  return "no trades";
}

function presetSummary(): string {
  return BUILTIN_PRESETS.map((p) => {
    const rights = [p.allowsBuy ? "buy" : null, p.allowsSell ? "sell" : null].filter(Boolean).join("+");
    const params = p.paramsSchema
      .map((f) => {
        const range =
          f.type === "select"
            ? ` one of ${JSON.stringify(f.options ?? [])}`
            : f.min !== undefined || f.max !== undefined
              ? ` [${f.min ?? "-inf"}..${f.max ?? "+inf"}]`
              : "";
        return `    - ${f.key} (${f.type}${range}): ${f.label}`;
      })
      .join("\n");
    return `- "${p.key}" (id ${p.id}, ${p.title}, actions: ${rights}): ${p.description}\n  params:\n${params}`;
  }).join("\n");
}

export function strategyGuideText(): string {
  return `# Glint StrategySpec guide

Glint agents trade **spot only** on Lighter on Robinhood Chain from the user's OWN Lighter account:
tokenized stocks and ETFs (${DEFAULT_MARKET_SYMBOLS.join(", ")}, TSLA, MSFT, AMD, ...), all quoted in USDG.
A pair is enabled automatically once its 24h volume meets the liquidity threshold; list_markets shows the current set. No leverage, no shorts, no perps.
The account is identified by the user's EVM (L1) address (hlAccount); it must already exist (the first USDG deposit on Lighter creates it).
Each agent gets its own Lighter API key on that account. Glint uses the key only to create orders, cancel and cancel all;
withdrawing isn't part of what the agent does. This MCP server never signs transactions and never holds keys. Never ask the user for a private key or seed phrase.
Capital: each agent gets its own allocation in USDG (allocationUsd in create_agent): it only spends that USDG and only sells what it bought. Minimum 10 USDG, recommended at least 30 (Lighter's minimum order is 10 USDG). Ask the user how much to allocate.
A market can be closed or halted by Lighter (status not active): the agent does not buy it until it reopens. Presets that never buy (${
    BUILTIN_PRESETS.filter((p) => !p.allowsBuy)
      .map((p) => p.key)
      .join(", ") || "none"
  }) need no capital: omit allocationUsd.

## Workflow
1. list_presets (presets + paramsSchema + defaults per profile), list_markets (whitelisted spot symbols), list_models.
   get_platform_config shows interval limits (min / premiumMin / options).
2. Build a spec: start from the chosen preset's defaults[profile] (risk + params), then adjust to the user's request.
   Or call draft_strategy(prompt, preset?) to let the backend AI draft one.
3. validate_strategy(spec): fix every error it reports and validate again until ok.
4. create_agent(spec, hlAccount, allocationUsd): creates a draft and returns a link. The user opens it and signs in their own wallet:
   Lighter ChangePubKey (registers the agent's API key), Lighter ApproveIntegrator (the platform fee, when one is set),
   optionally a consent to switch the account to Lighter's Plus tier (needed for a non-zero platform fee; Plus costs a 0.015% Lighter fee),
   and the createAgent transaction on AgentHub (Robinhood Chain). Always show the link and explain these signatures. Nothing is live until they sign.

## StrategySpec fields
- version: 1
- preset: preset key (${presetKeysText()} or another key from list_presets)
- name: <= ${LIMITS.nameMax} chars
- goal: <= ${LIMITS.goalMax} chars, plain-language instruction for the AI trader (the user's intent)
- markets: EITHER 1..${LIMITS.marketsMax} spot symbols from list_markets (selected pairs) OR ["*"] alone = all liquid pairs. In "*" mode the agent may buy any enabled liquid Lighter spot pair; each decision the AI sees its open positions plus a shortlist of the most liquid/active pairs, per-token limits still apply and the number of distinct tokens held at once is capped. Never mix "*" with symbols.
- quote: "USDG" (the Lighter quote on Robinhood Chain; "USDC" is still accepted and normalised)
- model: model id from list_models (tier "premium" only for utility-token holders)
- intervalSec: seconds between AI decisions, default ${DEFAULT_INTERVAL_SEC}. Minimum is intervals.min from config
  (normally 300); 60 s only for premium users (intervals.premiumMin).
- profile: "conservative" | "balanced" | "aggressive"
- risk (all shares in bps, 10000 = 100%; each bps value must be 1..10000):
  - maxPositionBps: max share of equity held in one token
  - maxTradeBps: max share of equity per trade
  - maxDailyLossBps: after this daily loss the agent only sells/protects, no new buys
  - maxTradesPerDay: integer >= 1
  - durationDays: 0 = unlimited
- params: preset parameters; keys, types and ranges come from the preset's paramsSchema (list_presets).

## Rules enforced by the risk engine (code, not AI)
- Buys only in spec.markets (or any enabled liquid pair in "*" mode) that are enabled on the platform; sells of a position you already hold are always allowed, even if the pair was disabled later.
- Preset rights: ${BUILTIN_PRESETS.map((p) => `${p.key} = ${presetRight(p)}`).join("; ")}.
- Trade size <= maxTradeBps; resulting token share <= maxPositionBps; trades per day < maxTradesPerDay.
- Daily loss >= maxDailyLossBps: sells only.
- Min order ~${LIMITS.minOrderUsd} USDG; max slippage for IOC orders ${LIMITS.maxSlippageBps} bps from mid.
- Stop-loss / take-profit / trailing params (the preset's "protection" fields) are executed by code every ~15 s, independent of the AI.
- Conservative risk = smaller maxPositionBps / maxTradeBps / maxDailyLossBps, fewer trades; aggressive = larger.

## Built-in presets (${BUILTIN_PRESETS.length}: ${BUILTIN_PRESETS.map((p) => p.title).join(", ")})
${presetSummary()}
Call list_presets for the exact paramsSchema and defaults of each preset (new presets may appear there too).

## Example spec (trend on NVDA and SPY, conservative risk)
\`\`\`json
${JSON.stringify(exampleSpec(), null, 2)}
\`\`\`
Replace "model" with a real id from list_models, then validate_strategy before create_agent.
`;
}
