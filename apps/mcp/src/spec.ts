// Types and constants of the Glint public API that this server needs.
// Vendored on purpose: the MCP server is Apache-2.0 and self-contained; it depends on the API contract only,
// not on the trading core packages. Keep these in sync with the public API (GET /v1/config, /v1/presets, ...).

export type Hex = `0x${string}`;
export type RiskProfile = "conservative" | "balanced" | "aggressive";
export type PresetParamValue = number | string | boolean | Record<string, number>;
export type GenericParams = Record<string, PresetParamValue>;

/** Hard limits of an agent. Every share is in bps (10000 = 100%). */
export interface RiskBox {
  maxPositionBps: number;
  maxTradeBps: number;
  maxDailyLossBps: number;
  maxTradesPerDay: number;
  durationDays: number;
}

/** Agent strategy specification. Its canonical-JSON hash is stored in AgentHub as specHash. */
export interface StrategySpec {
  version: 1;
  preset: string;
  name: string;
  goal: string;
  /** Base symbols of Lighter spot pairs on Robinhood Chain (["NVDA","SPY"]) or ["*"] for all enabled liquid pairs. */
  markets: string[];
  /** Quote on Lighter (Robinhood Chain) is USDG. "USDC" from older clients is accepted and normalised to "USDG". */
  quote: "USDG" | "USDC";
  model: string;
  intervalSec: number;
  profile: RiskProfile;
  risk: RiskBox;
  params: GenericParams;
}

export interface PresetParamField {
  key: string;
  label: string;
  type: "number" | "string" | "boolean" | "select" | "weights";
  options?: string[];
  min?: number;
  max?: number;
}

export interface PresetInfo {
  key: string;
  id: number;
  title: string;
  description: string;
  allowsBuy: boolean;
  allowsSell: boolean;
  enabled: boolean;
  builtin?: boolean;
  indicators?: unknown[];
  promptTemplate?: string;
  protection?: Record<string, string | undefined>;
  rules?: Record<string, unknown>;
  manageExistingHoldings?: boolean;
  riskLabel?: "low" | "medium" | "high";
  paramsSchema: PresetParamField[];
  defaults: Record<RiskProfile, { risk: RiskBox; params: GenericParams }>;
}

export interface MarketInfo {
  symbol: string; // base asset, e.g. "NVDA"
  pair: string; // Lighter spot pair, e.g. "NVDA/USDG"
  hlSpotIndex: number; // Lighter market_id (field name kept for API compatibility)
  marketId?: number;
  szDecimals: number;
  priceDecimals?: number;
  enabled: boolean;
  status?: string;
  open?: boolean;
  closedReason?: string;
  dayVolumeUsd?: number;
  midUsd?: number;
  tier?: "liquid" | "thin" | "illiquid";
  change24hPct?: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  tier: "standard" | "premium";
  enabled: boolean;
}

/** Lighter on Robinhood Chain. Fees in millionths: 100 = 1 bp. */
export interface ExchangeInfo {
  name: "lighter-rh";
  api: string;
  chainId: number;
  isTestnet: boolean;
  quote: "USDG";
  integratorAccountIndex: number | null;
  spotTakerFee: number;
  spotMakerFee: number;
  feePct: string;
  approvalDays: number;
  feeRequiresTier: "plus";
}

export interface PublicConfig {
  chainId: number;
  hubAddress: Hex;
  usdcAddress?: Hex;
  builder?: { address: Hex; feeTenthsBp: number };
  exchange?: ExchangeInfo;
  intervals: { min: number; premiumMin: number; default: number; options: number[] };
  presets: PresetInfo[];
  markets: MarketInfo[];
  models: ModelInfo[];
  [extra: string]: unknown;
}

export interface AgentView {
  id: number;
  owner: Hex;
  preset: string;
  locked: boolean;
  status: "active" | "paused" | "stopped";
  intervalSec: number;
  createdAt: number;
  sourceAgentId: number;
  specHash: Hex;
  model: string;
  hlAccount: Hex; // the user's L1 (EVM) address that owns the Lighter account
  apiWallet: Hex; // first 20 bytes of keccak256(the agent's Lighter API public key)
  risk: RiskBox;
  name?: string;
  [extra: string]: unknown;
}

export interface TradeView {
  agentId: number;
  side: "buy" | "sell";
  market: string;
  sizeUsd: number;
  price: number;
  reason: string;
  hlOrderId: number; // Lighter order index (field name kept for API compatibility)
  timestamp: number;
  txHash?: Hex;
}

export interface ListingStrategy {
  description: string;
  descriptionSource: "ai" | "template" | "seller";
  goal: string;
  preset: string;
  profile: RiskProfile;
  params: GenericParams;
  model: string;
  intervalSec: number;
  risk: RiskBox;
  markets: string[];
  specHash: Hex;
  synced: boolean;
}

export interface ListingView {
  id: number;
  agentId: number;
  seller: Hex;
  payToken: Hex; // 0x0 = native ETH
  price: string; // base units
  active: boolean;
  sales: number;
  title: string;
  blurb: string;
  preset: string;
  risk: RiskBox;
  markets: string[];
  strategy?: ListingStrategy;
  [extra: string]: unknown;
}

export type OnboardingStepStatus = "pending" | "submitted" | "done" | "failed" | "stale" | "not_needed";

/** What the user's wallet signs on Lighter before the agent is activated (personal_sign from the account's L1 wallet). */
export interface LighterOnboarding {
  accountIndex: number;
  apiKeyIndex: number;
  apiPublicKey: string;
  chainId: number;
  /** Registers the agent's API key on the account (ChangePubKey). Required. */
  changePubKey: { messageToSign: string; status: OnboardingStepStatus; txHash?: string; error?: string };
  /** Approves the platform integrator account for the platform fee (ApproveIntegrator). null when the fee is 0. */
  approveIntegrator: {
    messageToSign: string;
    integratorAccountIndex: number;
    maxSpotTakerFee: number;
    maxSpotMakerFee: number;
    feePct: string;
    approvalExpiryMs: number;
    status: OnboardingStepStatus;
    txHash?: string;
    error?: string;
  } | null;
  tier: {
    current: string | null;
    required: "plus" | null;
    consentMessage: string | null;
    status: OnboardingStepStatus | "declined";
    error?: string;
  };
  feeMode: string | null;
  ready: boolean;
}

export interface PrepareAgentResponse {
  draftId: string;
  apiWallet: Hex;
  agentName: string;
  specHash: Hex;
  modelId: Hex;
  presetId: number;
  intervalSec: number;
  risk: RiskBox;
  /** @deprecated compatibility field; use lighter.approveIntegrator. */
  builder: { address: Hex; maxFeeRate: string };
  allocationUsd?: number | null;
  reusesHlName?: boolean;
  lighter?: LighterOnboarding;
}

export interface ApiError {
  error: { code: string; message: string };
}

/** Native ETH is address(0) as a marketplace pay token on Robinhood Chain. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

export const DEFAULT_INTERVAL_SEC = 300;

/** Starter spot markets on Lighter (base symbols of SYMBOL/USDG pairs). */
export const DEFAULT_MARKET_SYMBOLS = ["NVDA", "SPY", "QQQ"];

export const LIMITS = {
  nameMax: 64,
  goalMax: 600,
  marketsMax: 8,
  actionsPerDecisionMax: 3,
  maxSlippageBps: 100,
  minOrderUsd: 10,
} as const;

/** Public summary of a built-in preset (no prompt templates). Live presets, params and defaults: list_presets. */
export interface BuiltinPreset {
  key: string;
  id: number;
  title: string;
  description: string;
  allowsBuy: boolean;
  allowsSell: boolean;
  paramsSchema: PresetParamField[];
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    key: "dca",
    id: 0,
    title: "DCA",
    description: "Buys the selected tokens in portions on a schedule. The AI picks the timing and allocation. Never sells.",
    allowsBuy: true,
    allowsSell: false,
    paramsSchema: [
      { key: "buyEverySec", label: "Min seconds between buys", type: "number", min: 300, max: 604800 },
      { key: "budgetPerBuyBps", label: "Budget per buy, bps", type: "number", min: 10, max: 10000 },
    ],
  },
  {
    key: "protect",
    id: 1,
    title: "Protect",
    description: "Guards tokens you already hold: sells on stop-loss, takes profit, runs a trailing stop. Never opens new buys.",
    allowsBuy: false,
    allowsSell: true,
    paramsSchema: [
      { key: "stopLossPct", label: "Stop-loss, %", type: "number", min: 1, max: 50 },
      { key: "takeProfitPct", label: "Take-profit, %", type: "number", min: 1, max: 500 },
      { key: "trailingPct", label: "Trailing stop, %", type: "number", min: 1, max: 50 },
    ],
  },
  {
    key: "trend",
    id: 2,
    title: "Trend",
    description: "Buys in an uptrend and moves to USDG in a downtrend. Long only, with a stop on every position.",
    allowsBuy: true,
    allowsSell: true,
    paramsSchema: [
      { key: "timeframe", label: "Timeframe", type: "select", options: ["15m", "1h", "4h"] },
      { key: "fastEma", label: "Fast EMA", type: "number", min: 3, max: 100 },
      { key: "slowEma", label: "Slow EMA", type: "number", min: 5, max: 300 },
      { key: "stopLossPct", label: "Stop-loss, %", type: "number", min: 1, max: 50 },
    ],
  },
  {
    key: "rebalance",
    id: 3,
    title: "Rebalance",
    description:
      "Keeps a target portfolio (e.g. 50% SPY, 30% NVDA, rest USDG). When a token drifts beyond the band, the code computes the trades back to the targets; the AI can only postpone or scale them down.",
    allowsBuy: true,
    allowsSell: true,
    paramsSchema: [
      { key: "targets", label: "Target weights (bps of equity)", type: "weights", min: 0, max: 10000 },
      { key: "driftBandBps", label: "Drift band, bps", type: "number", min: 50, max: 5000 },
      { key: "minRebalanceSec", label: "Min seconds between rebalances", type: "number", min: 300, max: 604800 },
      { key: "maxRebalanceTradeBps", label: "Max trade per rebalance, bps", type: "number", min: 100, max: 10000 },
    ],
  },
  {
    key: "momentum",
    id: 4,
    title: "Momentum (High risk)",
    description:
      "High risk. Chases strong breakouts on liquid pairs: buys only after a large 24h move confirmed by RSI and a fast EMA crossover, with a tight stop-loss, trailing stop and take-profit enforced by code. Expect frequent small losses and occasional large wins.",
    allowsBuy: true,
    allowsSell: true,
    paramsSchema: [
      { key: "minChange24hPct", label: "Min 24h change to enter, %", type: "number", min: 1, max: 100 },
      { key: "rsiMin", label: "RSI min", type: "number", min: 30, max: 90 },
      { key: "rsiMax", label: "RSI max", type: "number", min: 40, max: 99 },
      { key: "budgetPerBuyBps", label: "Budget per buy, bps", type: "number", min: 100, max: 10000 },
      { key: "maxPositions", label: "Max positions", type: "number", min: 1, max: 8 },
      { key: "cooldownSec", label: "Min seconds between buys", type: "number", min: 60, max: 86400 },
      { key: "stopLossPct", label: "Stop-loss, %", type: "number", min: 1, max: 30 },
      { key: "trailingPct", label: "Trailing stop, %", type: "number", min: 1, max: 30 },
      { key: "takeProfitPct", label: "Take-profit, %", type: "number", min: 2, max: 500 },
    ],
  },
];
