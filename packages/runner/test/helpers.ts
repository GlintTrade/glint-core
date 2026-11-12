// Test fakes: Lighter (Robinhood Chain spot), AgentHub reads, receipts and LLM providers. No network calls anywhere.
//
// Markets are tokenized stocks with synthetic prices chosen so the rounding in the assertions is easy to follow:
// NVDA/USDG (size 2 decimals, price 3 decimals, $40) and SPY/USDG (size 5 decimals, price 0 decimals, $100000).
import { randomBytes } from "node:crypto";
import { type HubClient, MemoryReceiptSink, type OnchainAgent, type OnchainIdentity, type OnchainListing } from "@glint/agenthub";
import {
  type AgentKeyRef,
  type ApiKeyInfo,
  type ApprovedIntegrator,
  apiWalletOf,
  type Candle,
  type CandleInterval,
  type ExchangeAccount,
  type ExchangeClient,
  type ExchangeFill,
  type ExchangeSpotMarket,
  type LighterKeyRow,
  MemoryLighterKeyStore,
  type OrderBook,
  type OrderRequest,
  type OrderResult,
  type SpotBalance,
} from "@glint/lighter";
import { type ModelInfo, PRESETS, type StrategySpec } from "@glint/strategy";
import type { Log } from "viem";
import type { IntegratorConfig } from "../src/approvals.js";
import { runnerConfig } from "../src/config.js";
import { EncryptedKeyVault } from "../src/keys.js";
import { LlmRouter } from "../src/llm/router.js";
import { type LlmCompletion, type LlmCompletionRequest, LlmError, type LlmProvider } from "../src/llm/types.js";
import { Runner, type RunnerDeps } from "../src/runner.js";
import { MemoryStore } from "../src/store.js";
import { lc } from "../src/types.js";

export type Hex = `0x${string}`;
export const MASTER_KEY = "ab".repeat(32);
export const USER = "0x00000000000000000000000000000000000000e1" as Hex;
export const HL_ACC = "0x00000000000000000000000000000000000000f1" as Hex;
/** The platform's Lighter integrator (partner) account in tests; fee 100 millionths = 1 bp. */
export const INTEGRATOR = 777;
export const INTEGRATOR_FEE = 100;
export const INTEGRATOR_CONFIG: IntegratorConfig = { accountIndex: INTEGRATOR, spotTakerFee: INTEGRATOR_FEE, spotMakerFee: 0, required: true };

/** Synthetic platform models: two standard models on the primary endpoint, one premium. */
export const MODELS: ModelInfo[] = [
  { id: "model-a", label: "Model A", provider: "primary", tier: "standard", inputPricePer1M: 0.25, outputPricePer1M: 2, enabled: true },
  { id: "model-b", label: "Model B", provider: "primary", tier: "standard", inputPricePer1M: 0.1, outputPricePer1M: 0.2, enabled: true },
  { id: "model-premium", label: "Premium", provider: "primary", tier: "premium", inputPricePer1M: 3, outputPricePer1M: 15, enabled: true },
];

const mkt = (
  p: Partial<ExchangeSpotMarket> & Pick<ExchangeSpotMarket, "marketId" | "pair" | "szDecimals" | "priceDecimals" | "lastPrice" | "dayQuoteVolume">,
): ExchangeSpotMarket => ({
  base: p.pair.split("/")[0] ?? p.pair,
  quote: p.pair.split("/")[1] ?? "",
  minBaseAmount: 0,
  minQuoteAmount: 10,
  status: "active",
  isFrozen: false,
  startTimestamp: 0,
  endTimestamp: 0,
  dayPriceChangePct: 0,
  ...p,
});

export const SPOT_MARKETS: ExchangeSpotMarket[] = [
  mkt({ marketId: 2107, pair: "NVDA/USDG", szDecimals: 2, priceDecimals: 3, lastPrice: 40, dayQuoteVolume: 1_000_000 }),
  mkt({ marketId: 2140, pair: "SPY/USDG", szDecimals: 5, priceDecimals: 0, lastPrice: 100000, dayQuoteVolume: 500_000 }),
  mkt({ marketId: 9, pair: "NVDA", szDecimals: 2, priceDecimals: 4, lastPrice: 41, dayQuoteVolume: 99_999_999, quote: "" }), // not a USDG spot pair: ignored
];

const randHex = (bytes: number) => randomBytes(bytes).toString("hex");

export class FakeExchange implements ExchangeClient {
  readonly isTestnet = true;
  readonly chainId = 300;
  markets: ExchangeSpotMarket[] = SPOT_MARKETS.map((m) => ({ ...m }));
  mids: Record<string, number> = { "NVDA/USDG": 40, "SPY/USDG": 100000 };
  balances = new Map<string, SpotBalance[]>();
  /** l1 -> account index (assigned on first use). */
  accounts = new Map<string, number>();
  keys = new Map<number, ApiKeyInfo[]>();
  integrators = new Map<number, ApprovedIntegrator[]>();
  tiers = new Map<number, string>();
  orders: { pk: string; key: AgentKeyRef; order: OrderRequest }[] = [];
  candleCloses: number[] = Array.from({ length: 200 }, (_, i) => 30 + i * 0.05);
  fills: ExchangeFill[] = [];
  orderResult?: (o: OrderRequest) => OrderResult;
  /** Book override by coin; by default a deep book +/-5 bps around the mid. */
  books = new Map<string, OrderBook>();
  private nextAccount = 1000;

  async spotMarkets() {
    return this.markets.map((m) => ({ ...m, lastPrice: this.mids[m.pair] ?? m.lastPrice }));
  }
  async allMids() {
    return { ...this.mids };
  }
  async candles(_coin: string, _i: CandleInterval, start: number): Promise<Candle[]> {
    return this.candleCloses.map((c, i) => ({ t: start + i * 60_000, o: c, h: c, l: c, c, v: 1 }));
  }
  async l2Book(coin: string): Promise<OrderBook> {
    const custom = this.books.get(coin);
    if (custom) return custom;
    const mid = this.mids[coin] ?? 0;
    if (!(mid > 0)) return { bids: [], asks: [] };
    const lv = (sign: number) => Array.from({ length: 20 }, (_, i) => ({ px: mid * (1 + sign * 0.0005 * (i + 1)), sz: 1e9 / mid }));
    return { bids: lv(-1), asks: lv(1) };
  }
  accountOf(l1: string): number {
    const k = l1.toLowerCase();
    if (!this.accounts.has(k)) this.accounts.set(k, this.nextAccount++);
    return this.accounts.get(k)!;
  }
  async accountIndexOf(l1: Hex) {
    return this.accountOf(l1);
  }
  private l1Of(accountIndex: number): string | undefined {
    return [...this.accounts.entries()].find(([, i]) => i === accountIndex)?.[0];
  }
  async account(accountIndex: number): Promise<ExchangeAccount | null> {
    const l1 = this.l1Of(accountIndex);
    if (!l1) return null;
    return { accountIndex, l1Address: l1 as Hex, balances: this.balances.get(l1) ?? [], approvedIntegrators: this.integrators.get(accountIndex) ?? [] };
  }
  async spotBalances(user: Hex) {
    return this.balances.get(user.toLowerCase()) ?? [];
  }
  async apiKeys(accountIndex: number) {
    return this.keys.get(accountIndex) ?? [];
  }
  async nextNonce() {
    return 0;
  }
  async accountTier(key: AgentKeyRef) {
    return this.tiers.get(key.accountIndex) ?? "plus";
  }
  async fillsSince() {
    return this.fills;
  }
  async placeOrder(key: AgentKeyRef, order: OrderRequest): Promise<OrderResult> {
    this.orders.push({ pk: key.privateKey, key, order });
    if (this.orderResult) return this.orderResult(order);
    return {
      status: "filled",
      oid: 1000 + this.orders.length,
      orderIndex: String(5e17 + this.orders.length),
      txHash: randHex(40),
      filledSz: Number(order.size),
      avgPx: Number(order.price),
    };
  }

  /** Approves the platform's integrator on the account of l1 (what the user's ApproveIntegrator does). */
  approveIntegrator(l1: Hex, maxSpotTakerFee = INTEGRATOR_FEE * 10, expiryMs = Date.now() + 180 * 86400e3) {
    const accountIndex = this.accountOf(l1);
    this.integrators.set(accountIndex, [
      ...(this.integrators.get(accountIndex) ?? []).filter((x) => x.accountIndex !== INTEGRATOR),
      { accountIndex: INTEGRATOR, maxSpotTakerFee, maxSpotMakerFee: maxSpotTakerFee, approvalExpiry: expiryMs },
    ]);
  }
}

/** AgentHub reads only (the runner never needs anything else from the contract). */
export class FakeHub implements HubClient {
  readonly enabled = true;
  readonly address = "0x00000000000000000000000000000000000000a1" as Hex;
  agents = new Map<number, OnchainAgent>();
  listings = new Map<number, OnchainListing>();
  premium = new Set<string>();

  async getAgent(id: number) {
    return this.agents.get(id) ?? null;
  }
  async getListing(id: number) {
    return this.listings.get(id) ?? null;
  }
  async getIdentity(): Promise<OnchainIdentity | null> {
    return null;
  }
  async isPremium(u: Hex) {
    return this.premium.has(u.toLowerCase());
  }
  async blockNumber() {
    return 100n;
  }
  async getLogs(): Promise<Log[]> {
    return [];
  }
  async getBlockTimestamp() {
    return 1_700_000_000;
  }
  async getReceiptLogs() {
    return { logs: [] as Log[], blockNumber: 1n, status: "success" as const };
  }
}

/** LLM provider with a queue of answers: a string is the response text, an Error is thrown. */
export class FakeProvider implements LlmProvider {
  calls: LlmCompletionRequest[] = [];
  constructor(
    readonly name: string,
    public queue: (string | Error)[] = [],
    public isAvailable = true,
    readonly defaultModel?: string,
  ) {}
  available() {
    return this.isAvailable;
  }
  async complete(req: LlmCompletionRequest): Promise<LlmCompletion> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new LlmError(`${this.name}: no answer queued`, this.name);
    if (next instanceof Error) throw next;
    return { provider: this.name, model: req.model, text: next, usage: { inputTokens: 1000, outputTokens: 200 } };
  }
}

export interface WorldOptions {
  primary?: FakeProvider;
  fallback?: FakeProvider;
  exchange?: FakeExchange;
  hub?: FakeHub;
  now?: () => number;
  deps?: Partial<RunnerDeps>;
}

/** A complete runner world on MemoryStore with fakes. Markets are synced from FakeExchange. */
export async function makeWorld(o: WorldOptions = {}) {
  const store = new MemoryStore({ models: MODELS, presets: PRESETS });
  const exchange = o.exchange ?? new FakeExchange();
  const hub = o.hub ?? new FakeHub();
  const receipts = new MemoryReceiptSink();
  const keyRows = new MemoryLighterKeyStore();
  const primary = o.primary ?? new FakeProvider("primary", [], false);
  const fallback = o.fallback ?? new FakeProvider("fallback", [], false, "fallback-model");
  const llm = new LlmRouter({ providers: [primary, fallback], models: () => store.listModels(), usage: store, now: o.now });
  const keys = new EncryptedKeyVault(MASTER_KEY, keyRows);
  const runner = new Runner({
    store,
    exchange,
    keyRows,
    hub,
    receipts,
    llm,
    keys,
    config: runnerConfig(),
    integrator: INTEGRATOR_CONFIG,
    now: o.now,
    ...o.deps,
  });
  await runner.refreshMarkets();
  return { store, exchange, hub, receipts, keyRows, primary, fallback, llm, keys, runner };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

/** A fresh Lighter API key (random bytes: the tests never sign anything). */
export function fakeLighterKey(): { privateKey: string; publicKey: string; apiWallet: Hex } {
  const publicKey = randHex(40);
  return { privateKey: `0x${randHex(40)}`, publicKey, apiWallet: lc(apiWalletOf(publicKey)) };
}

/**
 * Registers an activated agent: on-chain (FakeHub), in the store, its key in the vault and in the onboarding rows,
 * the key registered on the Lighter account (ChangePubKey) and, unless integrator=false, the integrator approved.
 */
export function addAgent(
  w: World,
  o: {
    id: number;
    spec: StrategySpec;
    owner?: Hex;
    hlAccount?: Hex;
    chainStatus?: number;
    createdAt?: number;
    allocationUsd?: number | null;
    register?: boolean;
    integrator?: boolean;
    tier?: string;
  },
) {
  const preset = PRESETS.find((p) => p.key === o.spec.preset);
  if (!preset) throw new Error(`unknown preset ${o.spec.preset}`);
  const key = fakeLighterKey();
  const hlAccount = o.hlAccount ?? HL_ACC;
  const accountIndex = w.exchange.accountOf(hlAccount);
  const apiKeyIndex = 254 - (w.exchange.keys.get(accountIndex)?.length ?? 0) - w.keyRows.byAccount(accountIndex).length;
  const chain: OnchainAgent = {
    id: o.id,
    owner: o.owner ?? USER,
    preset: preset.id,
    locked: false,
    status: o.chainStatus ?? 0,
    intervalSec: o.spec.intervalSec,
    createdAt: o.createdAt ?? 1,
    sourceAgentId: 0,
    specHash: "0x01",
    modelId: "0x02",
    hlAccount,
    apiWallet: key.apiWallet,
    risk: o.spec.risk,
  };
  w.hub.agents.set(o.id, chain);
  w.store.upsertChainAgent({ ...chain, presetId: preset.id, chainStatus: chain.status });
  w.store.activateAgent(o.id, o.spec);
  w.keys.put(key.apiWallet, key.privateKey);
  const now = Math.floor(Date.now() / 1000);
  const row: LighterKeyRow = {
    apiWallet: key.apiWallet,
    l1Address: lc(hlAccount),
    accountIndex,
    apiKeyIndex,
    publicKey: key.publicKey,
    draftId: null,
    agentId: o.id,
    cpkNonce: 0,
    cpkMessage: "test",
    cpkStatus: "done",
    cpkTxHash: null,
    cpkError: null,
    aiNonce: 1,
    aiMessage: "test",
    aiStatus: "done",
    aiTxHash: null,
    aiError: null,
    aiTakerFee: INTEGRATOR_FEE,
    aiMakerFee: 0,
    aiExpiryMs: Date.now() + 180 * 86400e3,
    tier: o.tier ?? "plus",
    tierStatus: "done",
    tierError: null,
    createdAt: now,
    updatedAt: now,
  };
  w.keyRows.insert(row);
  if (o.allocationUsd !== undefined) w.store.setCapital(o.id, o.allocationUsd, `lighter key #${apiKeyIndex}`);
  if (o.register !== false)
    w.exchange.keys.set(accountIndex, [...(w.exchange.keys.get(accountIndex) ?? []), { apiKeyIndex, publicKey: key.publicKey, nonce: 0 }]);
  if (o.integrator !== false) w.exchange.approveIntegrator(hlAccount);
  if (o.tier) w.exchange.tiers.set(accountIndex, o.tier);
  return { ...key, accountIndex, apiKeyIndex };
}

export const decisionJson = (actions: object[], note = "test") => JSON.stringify({ actions, note });
