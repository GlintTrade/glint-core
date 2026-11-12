// Runner domain records. Persistence is behind RunnerStore (store.ts); these are plain data.
import type { AgentAction, AgentDecision, RiskBox, StrategySpec } from "@glint/strategy";

export type Hex = `0x${string}`;
export const lc = (a: string) => a.toLowerCase() as Hex;

/** Off-chain status set by the platform: "paused" by the watchdog or a missing capital allocation. */
export type OffchainStatus = "ok" | "paused" | "stopped" | "killed";

/** Mutable per-agent loop state, persisted after every tick. */
export interface AgentState {
  lastDecisionAt?: number;
  lastDecisionMids?: Record<string, number>;
  /** Highest price since a position was opened (for trailing stops). */
  peaks?: Record<string, number>;
  dayStart?: { day: string; equity: number };
  /** Capital accounting mode in which dayStart/initialEquity were recorded ("ledger" | "whole_account"). A change resets them. */
  capitalMode?: string;
  initialEquity?: number;
  lastEquity?: number;
  lastEquityAt?: number;
  lastEpochAt?: number;
  lastTradeAt?: number;
  lastLlmError?: string;
  /** Platform fee state of the last execution (LighterFeeMode: charged, zero_fee_standard_tier, zero_fee_no_approval, disabled). */
  feeMode?: string;
}

/**
 * An agent as the runner sees it: the on-chain AgentHub fields plus the off-chain spec and loop state.
 * `hlAccount` and `apiWallet` are AgentHub field names kept for ABI compatibility: hlAccount is the user's EVM (L1)
 * address that owns the Lighter account, apiWallet is the address-shaped fingerprint of the agent's Lighter API key
 * (see apiWalletOf in @glint/lighter).
 */
export interface AgentRecord {
  id: number;
  owner: Hex;
  presetId: number;
  locked: boolean;
  chainStatus: number; // 0 Active, 1 Paused, 2 Stopped (mirrors AgentHub)
  intervalSec: number;
  createdAt: number;
  sourceAgentId: number;
  specHash: Hex;
  modelId: Hex;
  hlAccount: Hex; // the owner's L1 address (owns the Lighter account)
  apiWallet: Hex; // fingerprint of the agent's Lighter API key
  risk: RiskBox;
  spec: StrategySpec | null;
  activated: boolean;
  activatedAt: number | null;
  offchainStatus: OffchainStatus;
  pauseReason: string | null;
  protectOnly: boolean;
  state: AgentState;
}

export interface TradeRow {
  id: number;
  agentId: number;
  owner: Hex;
  side: "buy" | "sell";
  market: string;
  sizeUsd: number;
  sizeBase: number; // net of the fee charged in the received token (buys)
  price: number;
  reason: string;
  /** Our Lighter client_order_index (uint48). AgentHub receipts carry it in the `hlOrderId` field (historical ABI name). */
  hlOrderId: number;
  timestamp: number;
  /** Platform (Lighter integrator) fee of the trade in USD; 0 when no fee was charged. */
  platformFeeUsd: number;
  source: "llm" | "protect"; // protect = executed by code (stops, exit rules)
  recorded: boolean; // TradeRecorded receipt written on Robinhood Chain
  txHash: Hex | null;
  /** Lighter order id (exchange order_index as a decimal string) and the sendTx hash, kept off-chain. */
  exchangeOrderId?: string | null;
  exchangeTxHash?: string | null;
}

export type NewTrade = Omit<TradeRow, "id" | "recorded" | "txHash">;

export interface EpochRow {
  id: number;
  agentId: number;
  equityUsd: number;
  pnlBps: number;
  ts: number;
  recorded: boolean;
  txHash: Hex | null;
}

/** One entry of the decision log: what the AI (or the code) proposed and what the risk engine rejected. */
export interface DecisionRow {
  id: number;
  agentId: number;
  ts: number;
  provider: string; // LLM provider, or "code" for protective exits
  model: string; // model id, or "protection"
  decision: AgentDecision;
  rejections: { index: number; action: AgentAction; code: string; message: string }[];
}

/** Capital allocated to an agent on a shared Lighter account (see capital/ledger.ts). */
export interface AgentCapital {
  agentId: number;
  allocationUsd: number | null; // null = created before allocations (whole account)
  /** Display label of the agent's key slot (e.g. "lighter key #254"). */
  keyLabel: string | null;
  adopted: Record<string, number>; // holdings adopted under manageExistingHoldings
  updatedAt: number;
}
