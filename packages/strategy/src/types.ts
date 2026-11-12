// Core domain types: strategy spec, AI decision, presets, markets and models.
// This module has no runtime dependencies: types only.

/** Preset key. Built-in presets are "dca", "protect", "trend", "rebalance", "momentum"; new presets are data. */
export type PresetKey = string;
export type RiskProfile = "conservative" | "balanced" | "aggressive";

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

/** Indicators the backend can compute for any preset. A preset picks from this set. */
export type IndicatorSpec =
  | { kind: "ema"; period: number; timeframe: Timeframe }
  | { kind: "rsi"; period: number; timeframe: Timeframe }
  | { kind: "change"; lookback: number; timeframe: Timeframe } // price change, %
  | { kind: "volatility"; lookback: number; timeframe: Timeframe }; // standard deviation of returns, %

/** Preset parameters: a free-form object (numbers, strings, flags, weight maps) passed to the AI and the runner. */
export type PresetParamValue = number | string | boolean | Record<string, number>;
export type GenericParams = Record<string, PresetParamValue>;

/** Hard limits of an agent. Every share is in bps (10000 = 100%). Spot only, no leverage. */
export interface RiskBox {
  maxPositionBps: number; // max share of capital in one token
  maxTradeBps: number; // max share of capital per trade
  maxDailyLossBps: number; // past this daily loss the agent only protects: no new buys
  maxTradesPerDay: number;
  durationDays: number; // 0 = no end date
}

export interface DcaParams {
  buyEverySec: number;
  budgetPerBuyBps: number;
  buyBelowUsd?: Record<string, number>;
}

export interface ProtectParams {
  stopLossPct: number;
  takeProfitPct: number;
  trailingPct?: number;
}

export interface TrendParams {
  timeframe: "15m" | "1h" | "4h";
  fastEma: number;
  slowEma: number;
  stopLossPct: number;
}

/**
 * Agent strategy specification. The hash of its canonical JSON (see canonical.ts) is stored in the
 * AgentHub contract as `specHash`. A purchased (locked) copy runs exactly this spec and cannot change it.
 * params: DcaParams / ProtectParams / TrendParams for the built-in presets, otherwise per PresetInfo.paramsSchema.
 */
export interface StrategySpec {
  version: 1;
  preset: PresetKey;
  name: string; // <= LIMITS.nameMax
  goal: string; // <= LIMITS.goalMax, plain-language instruction for the AI
  markets: string[]; // base symbols of Lighter spot pairs ["NVDA","SPY"] (1..LIMITS.marketsMax) OR ["*"] = all enabled liquid pairs (see isAllMarkets)
  /** Quote/collateral on Lighter (Robinhood Chain): USDG. "USDC" from older clients is accepted and normalised to "USDG". */
  quote: "USDG" | "USDC";
  model: string; // model id from the platform model list
  intervalSec: number; // how often the AI makes a decision (default 300)
  profile: RiskProfile;
  risk: RiskBox;
  params: GenericParams;
}

/** An action proposed by the AI. Only the risk engine executes it, and only if it passes every limit. */
export interface AgentAction {
  type: "buy" | "sell" | "hold";
  market: string; // a symbol from spec.markets
  sizeBps: number; // buy: share of equity; sell: share of the current position in the token
  limitPriceUsd?: number; // optional; otherwise an aggressive IOC limit bounded by the slippage cap
  reason: string; // <= 280 chars, shown to the user as the explanation
}

export interface AgentDecision {
  actions: AgentAction[]; // 0..3 actions per decision
  note: string; // short market summary
}

/** A model the runner may call. `provider` names a configured OpenAI-compatible endpoint. */
export interface ModelInfo {
  id: string; // model id at the provider
  label: string;
  provider: string;
  tier: "standard" | "premium"; // premium: utility-token holders only
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  enabled: boolean;
}

export interface MarketInfo {
  symbol: string; // base asset: "NVDA"
  pair: string; // Lighter spot pair on Robinhood Chain: "NVDA/USDG"
  hlSpotIndex: number; // Lighter market_id (field name kept for API compatibility; same as marketId)
  marketId?: number; // Lighter market_id
  szDecimals: number; // Lighter size_decimals
  priceDecimals?: number; // Lighter price_decimals
  enabled: boolean;
  /** Lighter market status; only "active" (not frozen, inside the start/end window) is open for trading. */
  status?: string;
  /** Open for new buys right now. Closed markets still allow selling a held position when the exchange accepts it. */
  open?: boolean;
  closedReason?: string; // "status:<status>" | "frozen" | "not_started" | "ended"
  // --- liquidity stats (optional, filled by the market sync) ---
  dayVolumeUsd?: number; // 24h volume in USDG (daily_quote_token_volume)
  midUsd?: number; // last mid price
  lastSyncAt?: number; // unix seconds of the last sync
  tier?: MarketTier; // liquid >= liquidDayVolumeUsd, thin >= minMarketDayVolumeUsd, otherwise illiquid
  change24hPct?: number; // 24h price change, %
  /** true: the market state is pinned by the platform; otherwise automatic (enabled once 24h volume >= minMarketDayVolumeUsd). */
  pinned?: boolean;
}

export type MarketTier = "liquid" | "thin" | "illiquid";

/** Liquidity guard thresholds (the risk engine applies them to every order). */
export interface LiquidityLimitsInfo {
  minMarketDayVolumeUsd: number; // below this the market is illiquid and orders are rejected
  liquidDayVolumeUsd: number; // threshold of the "liquid" tier
  maxSpreadBps: number;
  maxOrderPctOfDayVolume: number; // percent of the 24h volume
  maxSlippageBps: number;
}

/**
 * Indicator condition of a preset. Operands: { ind: i } is the value of the i-th indicator in preset.indicators
 * (periods/timeframe may be overridden by agent params), { price: true } is the current mid, { value: n } is a number,
 * { param: name } is the agent's numeric params[name].
 */
export type RuleOperand = { ind: number } | { price: true } | { value: number } | { param: string };
export interface IndicatorCondition {
  left: RuleOperand;
  op: ">" | "<" | ">=" | "<=";
  right: RuleOperand;
}

/**
 * Preset rules enforced by CODE (risk engine and runner), not only by the AI prompt. All data, no per-preset branches.
 * Values are read from the agent params under the given names.
 */
export interface PresetRules {
  minBuyIntervalParam?: string; // min seconds between buys = params[name]
  maxBuyBpsParam?: string; // max size of one buy in bps = params[name] (on top of risk.maxTradeBps)
  buyBelowParam?: string; // params[name] = { SYMBOL: usd }: buy a token only while mid <= that price
  buyWhen?: IndicatorCondition[]; // a buy is allowed only if ALL conditions hold (missing data = rejection)
  exitWhen?: IndicatorCondition[]; // code sells the whole position when ALL conditions hold (like protective stops)
  maxPositionsParam?: string; // max number of distinct tokens in the agent portfolio = params[name]
  /**
   * Rebalancing (code computes the plan; the AI may only postpone it or execute part of it, never overshoot the targets):
   * params[targetsParam] = { SYMBOL: bps } target weights (the rest stays in USDG), params[bandParam] drift band in bps,
   * params[minIntervalParam] min seconds between rebalances.
   */
  rebalance?: { targetsParam: string; bandParam: string; minIntervalParam?: string };
}

export interface PresetParamField {
  key: string;
  label: string;
  type: "number" | "string" | "boolean" | "select" | "weights"; // weights: { SYMBOL: bps } target weights
  options?: string[]; // for select
  min?: number;
  max?: number;
}

/** A preset is data. The built-in ones are in presets.ts; `id` is the presetId in the contract. */
export interface PresetInfo {
  key: PresetKey;
  id: number; // = presetId in the contract
  title: string;
  description: string;
  allowsBuy: boolean; // risk engine: buying allowed
  allowsSell: boolean; // risk engine: selling allowed
  enabled: boolean;
  builtin: boolean;
  indicators: IndicatorSpec[]; // what to compute and give to the AI
  promptTemplate: string; // instruction for the AI; placeholders {{goal}} {{params}} {{risk}}
  protection?: { stopLossParam?: string; takeProfitParam?: string; trailingParam?: string }; // params that are protective stops (executed by code, not the AI)
  rules?: PresetRules; // rules checked by code (buy interval/budget, indicator entry/exit conditions)
  /** The agent manages account tokens that no running agent owns (Protect). Default false. */
  manageExistingHoldings?: boolean;
  /** Risk label for the UI ("high" shows as High risk). */
  riskLabel?: "low" | "medium" | "high";
  paramsSchema: PresetParamField[]; // for the site form and validation
  defaults: Record<RiskProfile, { risk: RiskBox; params: GenericParams }>;
}

/**
 * Platform fee state of an account on Lighter:
 *  charged                - integrator approved and the account is Plus/Premium: the fee is charged;
 *  zero_fee_standard_tier - approved, but the account is Standard: Lighter forbids non-zero partner fees (21520);
 *  zero_fee_no_approval   - no valid ApproveIntegrator (missing, expired, revoked, or 4 partners already);
 *  disabled               - the platform charges no fee (config).
 */
export type LighterFeeMode = "charged" | "zero_fee_standard_tier" | "zero_fee_no_approval" | "disabled";

/** ERC-8004 identity of an agent. The Identity Registry lives on Robinhood Chain (4663 mainnet / 46630 testnet). */
export interface AgentIdentity {
  status: "pending" | "registering" | "registered" | "transferring" | "linking" | "done" | "registry_unavailable" | "waiting_gas" | "failed";
  chainId: number;
  registry: `0x${string}`;
  erc8004Id?: number; // tokenId in the registry (ids start at 0)
  agentRegistry: string; // CAIP-10: eip155:<chainId>:<registry>
  agentUri: string; // URL of the registration file
  nftOwner?: `0x${string}`;
  registerTx?: `0x${string}`;
  linkedOnChain: boolean; // AgentHub.setAgentIdentity done
  explorerUrl?: string;
  lastError?: string;
}
