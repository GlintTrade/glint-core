// Minimal fake of the Glint REST API (node:http) with fixtures, for the MCP end-to-end test.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentView, ListingView, MarketInfo, PrepareAgentResponse, PresetInfo, PublicConfig, StrategySpec } from "../src/spec";

export const API_KEY = "ek_test_key";
export const DRAFT_ID = "3f2b8c1e-9d4a-4e6f-8a7b-1c2d3e4f5a6b"; // backend drafts are UUIDs
const ZERO = "0x0000000000000000000000000000000000000000" as const;

const risk = { maxPositionBps: 3000, maxTradeBps: 1500, maxDailyLossBps: 300, maxTradesPerDay: 6, durationDays: 30 };

export const PRESETS: PresetInfo[] = [
  {
    key: "dca",
    id: 0,
    title: "DCA",
    description: "Buys the selected tokens in portions on a schedule. Never sells.",
    allowsBuy: true,
    allowsSell: false,
    enabled: true,
    promptTemplate: "internal prompt template",
    paramsSchema: [
      { key: "buyEverySec", label: "Min seconds between buys", type: "number", min: 300, max: 604800 },
      { key: "budgetPerBuyBps", label: "Budget per buy, bps", type: "number", min: 10, max: 10000 },
    ],
    defaults: {
      conservative: { risk, params: { buyEverySec: 86400, budgetPerBuyBps: 300 } },
      balanced: { risk, params: { buyEverySec: 21600, budgetPerBuyBps: 500 } },
      aggressive: { risk, params: { buyEverySec: 3600, budgetPerBuyBps: 1000 } },
    },
  },
  {
    key: "trend",
    id: 2,
    title: "Trend",
    description: "Buys in an uptrend and moves to USDG in a downtrend.",
    allowsBuy: true,
    allowsSell: true,
    enabled: true,
    promptTemplate: "internal prompt template",
    paramsSchema: [
      { key: "timeframe", label: "Timeframe", type: "select", options: ["15m", "1h", "4h"] },
      { key: "fastEma", label: "Fast EMA", type: "number", min: 3, max: 100 },
      { key: "slowEma", label: "Slow EMA", type: "number", min: 5, max: 300 },
      { key: "stopLossPct", label: "Stop-loss, %", type: "number", min: 1, max: 50 },
    ],
    defaults: {
      conservative: { risk, params: { timeframe: "4h", fastEma: 20, slowEma: 50, stopLossPct: 5 } },
      balanced: { risk, params: { timeframe: "1h", fastEma: 20, slowEma: 50, stopLossPct: 7 } },
      aggressive: { risk, params: { timeframe: "15m", fastEma: 9, slowEma: 21, stopLossPct: 10 } },
    },
  },
];

const markets: (MarketInfo & { midUsd: number })[] = [
  { symbol: "NVDA", pair: "NVDA/USDG", hlSpotIndex: 2048, szDecimals: 3, priceDecimals: 2, enabled: true, status: "active", open: true, midUsd: 182.4 },
  { symbol: "SPY", pair: "SPY/USDG", hlSpotIndex: 2049, szDecimals: 3, priceDecimals: 2, enabled: true, status: "active", open: true, midUsd: 668.1 },
];

const config: PublicConfig = {
  chainId: 4663,
  hubAddress: "0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c",
  builder: { address: ZERO, feeTenthsBp: 50 },
  exchange: {
    name: "lighter-rh",
    api: "https://lighter.example.test",
    chainId: 300,
    isTestnet: true,
    quote: "USDG",
    integratorAccountIndex: 777,
    spotTakerFee: 500,
    spotMakerFee: 500,
    feePct: "0.05%",
    approvalDays: 180,
    feeRequiresTier: "plus",
  },
  intervals: { min: 300, premiumMin: 60, default: 300, options: [60, 300, 900, 3600] },
  presets: PRESETS,
  markets,
  models: [
    { id: "test/standard-model", label: "Standard model", tier: "standard", enabled: true },
    { id: "test/premium-model", label: "Premium model", tier: "premium", enabled: true },
  ],
};

const agent: AgentView = {
  id: 7,
  owner: "0x3333333333333333333333333333333333333333",
  preset: "trend",
  locked: false,
  status: "active",
  intervalSec: 300,
  createdAt: 1_762_000_000,
  sourceAgentId: 0,
  specHash: "0xabababababababababababababababababababababababababababababababab",
  model: "test/standard-model",
  hlAccount: "0x3333333333333333333333333333333333333333",
  apiWallet: "0x4444444444444444444444444444444444444444",
  risk,
  name: "Trend NVDA",
};

const listing: ListingView = {
  id: 3,
  agentId: 7,
  seller: agent.owner,
  payToken: ZERO,
  price: "1500000000000000000",
  active: true,
  sales: 2,
  title: "Trend NVDA",
  blurb: "Conservative trend",
  preset: "trend",
  risk: agent.risk,
  markets: ["NVDA"],
  strategy: {
    description:
      "Follows the trend on NVDA: buys when the fast average is above the slow one, exits to USDG on a reversal. A 5% stop-loss is enforced by code.",
    descriptionSource: "ai",
    goal: "Ride NVDA uptrends",
    preset: "trend",
    profile: "conservative",
    params: { timeframe: "4h", fastEma: 20, slowEma: 50, stopLossPct: 5 },
    model: agent.model,
    intervalSec: 300,
    risk: agent.risk,
    markets: ["NVDA"],
    specHash: agent.specHash,
    synced: true,
  },
};

export interface FakeApi {
  url: string;
  requests: { method: string; path: string; auth?: string; body?: unknown }[];
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function apiError(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function validate(spec: StrategySpec): string[] {
  const errors: string[] = [];
  if (!PRESETS.some((p) => p.key === spec.preset)) errors.push(`unknown preset "${spec.preset}"`);
  for (const m of spec.markets) if (!markets.some((x) => x.symbol === m)) errors.push(`market "${m}" is not whitelisted`);
  if (!config.models.some((m) => m.id === spec.model)) errors.push(`model "${spec.model}" is not allowed`);
  for (const [k, v] of Object.entries(spec.risk)) {
    if (k.endsWith("Bps") && (v < 1 || v > 10000)) errors.push(`risk.${k} must be 1..10000`);
  }
  if (spec.intervalSec < config.intervals.min) errors.push(`intervalSec must be >= ${config.intervals.min}`);
  return errors;
}

export async function startFakeApi(): Promise<FakeApi> {
  const requests: FakeApi["requests"] = [];

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const auth = req.headers.authorization;
    requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, auth, body });
    const authed = auth === `Bearer ${API_KEY}`;
    const route = `${req.method} ${url.pathname}`;

    const needAuth = () => {
      if (!authed) apiError(res, 401, "unauthorized", "invalid API key");
      return authed;
    };

    switch (route) {
      case "GET /v1/presets":
        return send(res, 200, { presets: PRESETS });
      case "GET /v1/config":
        return send(res, 200, config);
      case "GET /v1/markets":
        return send(res, 200, { markets });
      case "GET /v1/marketplace":
        return send(res, 200, { listings: [listing] });
      case "GET /v1/marketplace/3":
        return send(res, 200, listing);
      case "GET /v1/agents/7":
        return send(res, 200, agent);
      case "GET /v1/agents/7/trades":
        return send(res, 200, {
          trades: [{ agentId: 7, side: "buy", market: "NVDA", sizeUsd: 120, price: 40.1, reason: "EMA cross", hlOrderId: 1, timestamp: 1_762_100_000 }],
        });
      case "GET /v1/account":
        if (!needAuth()) return;
        return send(res, 200, { address: agent.owner, isPremium: false, agents: [agent] });
      case "POST /v1/strategies/validate": {
        if (!needAuth()) return;
        const spec = (body as { spec: StrategySpec }).spec;
        const errors = validate(spec);
        return send(res, 200, { ok: errors.length === 0, errors, specHash: errors.length ? undefined : `0x${"cd".repeat(32)}` });
      }
      case "POST /v1/agents/prepare": {
        if (!needAuth()) return;
        const { spec } = body as { spec: StrategySpec; hlAccount: string };
        const errors = validate(spec);
        if (errors.length) return apiError(res, 400, "invalid_spec", errors.join("; "));
        const out: PrepareAgentResponse = {
          draftId: DRAFT_ID,
          apiWallet: "0x5555555555555555555555555555555555555555",
          agentName: "lighter key #254",
          specHash: `0x${"cd".repeat(32)}`,
          modelId: `0x${"ef".repeat(32)}`,
          presetId: PRESETS.find((p) => p.key === spec.preset)?.id ?? 0,
          intervalSec: spec.intervalSec,
          risk: spec.risk,
          builder: { address: ZERO, maxFeeRate: "0.05%" },
          lighter: {
            accountIndex: 21897,
            apiKeyIndex: 254,
            apiPublicKey: `0x${"ab".repeat(40)}`,
            chainId: 300,
            changePubKey: { messageToSign: "Register Lighter Account ...", status: "pending" },
            approveIntegrator: {
              messageToSign: "Approve Integrator ...",
              integratorAccountIndex: 777,
              maxSpotTakerFee: 500,
              maxSpotMakerFee: 500,
              feePct: "0.05%",
              approvalExpiryMs: 1_810_000_000_000,
              status: "pending",
            },
            tier: { current: null, required: "plus", consentMessage: "Switch my Lighter account to the Plus tier", status: "pending" },
            feeMode: null,
            ready: false,
          },
        };
        return send(res, 200, out);
      }
      case "POST /v1/agents/7/stop":
        if (!needAuth()) return;
        return send(res, 200, { ok: true });
      default:
        if (url.pathname.startsWith("/v1/agents/")) return apiError(res, 404, "not_found", "agent not found");
        return apiError(res, 404, "not_found", `no route ${route}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
