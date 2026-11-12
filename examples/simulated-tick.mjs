// One full decision of one agent, end to end, against in-memory stand-ins for Lighter, AgentHub and the model.
// Nothing touches a network. Run after `npm run build`:  node examples/simulated-tick.mjs
//
//   market data -> prompt (shares and percent only) -> model JSON -> risk engine -> liquidity guard
//   -> IOC order signed with the agent's Lighter API key -> fill -> TradeRecorded receipt batch
import { randomBytes } from "node:crypto";
import { MemoryReceiptSink } from "@glint/agenthub";
import { apiWalletOf, MemoryLighterKeyStore } from "@glint/lighter";
import { EncryptedKeyVault, LlmRouter, MemoryStore, Runner, runnerConfig } from "@glint/runner";
import { PRESETS } from "@glint/strategy";

const trend = PRESETS.find((p) => p.key === "trend");
const USER = "0x00000000000000000000000000000000000000e1"; // the user's wallet (L1 address of the Lighter account)
const ACCOUNT_INDEX = 1001; // the user's Lighter account
const API_KEY_INDEX = 254; // the API key slot the user registered for this agent (ChangePubKey)

// The agent's Lighter API key. In production it comes from the WASM signer (GenerateAPIKey) during onboarding;
// here it is random bytes because nothing is signed.
const publicKey = randomBytes(40).toString("hex");
const privateKey = `0x${randomBytes(40).toString("hex")}`;
const apiWallet = apiWalletOf(publicKey).toLowerCase(); // 20-byte fingerprint of the key, stored in AgentHub

// ---------- Lighter stand-in: one spot pair (NVDA/USDG), an uptrend, a deep book ----------
const exchange = {
  isTestnet: true,
  chainId: 300,
  orders: [],
  async spotMarkets() {
    return [
      {
        marketId: 2048,
        pair: "NVDA/USDG",
        base: "NVDA",
        quote: "USDG",
        szDecimals: 3,
        priceDecimals: 2,
        minBaseAmount: 0,
        minQuoteAmount: 10,
        lastPrice: 180,
        dayQuoteVolume: 5_000_000,
        dayPriceChangePct: 1.8,
        status: "active",
        isFrozen: false,
        startTimestamp: 0,
        endTimestamp: 0,
      },
    ];
  },
  async allMids() {
    return { "NVDA/USDG": 180 };
  },
  async candles(_pair, _tf, start) {
    return Array.from({ length: 200 }, (_, i) => {
      const c = 160 + i * 0.1;
      return { t: start + i * 60_000, o: c, h: c, l: c, c, v: 1 };
    });
  },
  async l2Book() {
    const lv = (s) => Array.from({ length: 20 }, (_, i) => ({ px: 180 * (1 + s * 0.0005 * (i + 1)), sz: 1000 }));
    return { bids: lv(-1), asks: lv(1) };
  },
  async accountIndexOf() {
    return ACCOUNT_INDEX;
  },
  async account(accountIndex) {
    return { accountIndex, l1Address: USER, balances: await this.spotBalances(), approvedIntegrators: [] };
  },
  async spotBalances() {
    return [{ coin: "USDG", total: 1000, hold: 0, entryNtl: 0 }];
  },
  async apiKeys() {
    return [{ apiKeyIndex: API_KEY_INDEX, publicKey, nonce: 0 }];
  },
  async nextNonce() {
    return 0;
  },
  async accountTier() {
    return "standard";
  },
  async fillsSince() {
    return [];
  },
  async placeOrder(_key, order) {
    this.orders.push(order);
    return { status: "filled", oid: 4242, orderIndex: "4242", txHash: "ab".repeat(20), filledSz: Number(order.size), avgPx: Number(order.price) };
  },
};

// ---------- AgentHub stand-in (reads only; receipts go to a ReceiptSink) ----------
const hub = {
  enabled: true,
  address: "0x00000000000000000000000000000000000000a1",
  agents: new Map(),
  async getAgent(id) {
    return this.agents.get(id) ?? null;
  },
  async getListing() {
    return null;
  },
  async getIdentity() {
    return null;
  },
  async isPremium() {
    return false;
  },
  async blockNumber() {
    return 1n;
  },
  async getLogs() {
    return [];
  },
  async getBlockTimestamp() {
    return 0;
  },
  async getReceiptLogs() {
    return { logs: [], blockNumber: 1n, status: "success" };
  },
};
const receipts = new MemoryReceiptSink();

// ---------- model stand-in: answers with two buys, the second one sized beyond the preset limit on purpose ----------
const model = {
  name: "primary",
  available: () => true,
  async complete(req) {
    console.log(`\n[prompt sent to the model, user part]\n${req.user.slice(0, 600)} ...\n`);
    const text = JSON.stringify({
      note: "Uptrend confirmed on 1h.",
      actions: [
        { type: "buy", market: "NVDA", sizeBps: 2000, limitPriceUsd: null, reason: "Fast EMA above slow EMA." },
        { type: "buy", market: "NVDA", sizeBps: 9000, limitPriceUsd: null, reason: "All in." },
      ],
    });
    return { provider: this.name, model: req.model, text, usage: { inputTokens: 900, outputTokens: 120 } };
  },
};

// ---------- wiring ----------
const models = [{ id: "example-model", label: "Example", provider: "primary", tier: "standard", enabled: true }];
const store = new MemoryStore({ models, presets: PRESETS });
const llm = new LlmRouter({ providers: [model], models: () => store.listModels() });
const keyRows = new MemoryLighterKeyStore();
const keys = new EncryptedKeyVault("11".repeat(32), keyRows); // the master key comes from your secret store in production
const runner = new Runner({ store, exchange, keyRows, hub, receipts, llm, keys, config: runnerConfig() });
await runner.refreshMarkets();

// Onboarding result: which Lighter account and API key slot this key is. Stored encrypted, bound to apiWallet.
const now = Math.floor(Date.now() / 1000);
keyRows.insert({
  apiWallet,
  l1Address: USER,
  accountIndex: ACCOUNT_INDEX,
  apiKeyIndex: API_KEY_INDEX,
  publicKey,
  draftId: null,
  agentId: 1,
  cpkNonce: 0,
  cpkMessage: "example",
  cpkStatus: "done",
  cpkTxHash: null,
  cpkError: null,
  aiNonce: null,
  aiMessage: null,
  aiStatus: "not_needed",
  aiTxHash: null,
  aiError: null,
  aiTakerFee: null,
  aiMakerFee: null,
  aiExpiryMs: null,
  tier: "standard",
  tierStatus: "not_needed",
  tierError: null,
  createdAt: now,
  updatedAt: now,
});
keys.put(apiWallet, privateKey);

const spec = {
  version: 1,
  preset: "trend",
  name: "NVDA trend",
  goal: "Ride confirmed uptrends in NVDA, go back to USDG on reversals.",
  markets: ["NVDA"],
  quote: "USDG",
  model: "example-model",
  intervalSec: 300,
  profile: "balanced",
  risk: trend.defaults.balanced.risk,
  params: trend.defaults.balanced.params,
};
const onchain = {
  id: 1,
  owner: USER,
  preset: trend.id,
  locked: false,
  status: 0,
  intervalSec: 300,
  createdAt: now - 1000,
  sourceAgentId: 0,
  specHash: "0x01",
  modelId: "0x02",
  hlAccount: USER, // ABI field name kept from the deployed contract: the trading account's L1 address
  apiWallet,
  risk: spec.risk,
};
hub.agents.set(1, onchain);
store.upsertChainAgent({ ...onchain, presetId: trend.id, chainStatus: 0 });
store.activateAgent(1, spec);

// ---------- one tick ----------
const out = await runner.tickAgent(store.getAgent(1));
console.log("[tick outcome]", out.kind, out.reason ?? "");
for (const o of out.orders ?? []) console.log(`  approved: ${o.side} ${o.sizeBase} ${o.market} @ ${o.limitPx} IOC`);
for (const r of out.rejections ?? []) console.log(`  rejected: ${r.action.type} ${r.action.sizeBps} bps ${r.action.market}: ${r.code}`);
console.log("[orders sent to Lighter]", exchange.orders);

await runner.flushTrades();
console.log("[TradeRecorded batch]", receipts.trades);
