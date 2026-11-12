// End-to-end: the built dist/index.js runs as a stdio server, an MCP SDK client connects to it,
// and the server talks to a fake REST API (node:http) with fixtures. Run `npm run build` first.

import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, type StrategySpec } from "../src/spec";
import { API_KEY, DRAFT_ID, type FakeApi, startFakeApi } from "./fake-api";

const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const WEB_URL = "https://app.example.test";
const HL_ACCOUNT = "0x3333333333333333333333333333333333333333";

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "glint-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function text(res: unknown): string {
  const r = res as CallToolResult;
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

/** A port nobody listens on. */
async function deadPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const goodSpec: StrategySpec = {
  version: 1,
  preset: "trend",
  name: "NVDA+SPY trend",
  goal: "Ride uptrends conservatively",
  markets: ["NVDA", "SPY"],
  quote: "USDG",
  model: "test/standard-model",
  intervalSec: 300,
  profile: "conservative",
  risk: { maxPositionBps: 3000, maxTradeBps: 1500, maxDailyLossBps: 300, maxTradesPerDay: 6, durationDays: 30 },
  params: { timeframe: "4h", fastEma: 20, slowEma: 50, stopLossPct: 5 },
};

describe("glint MCP server (stdio, built dist)", () => {
  let api: FakeApi;
  let client: Client;

  beforeAll(async () => {
    expect(existsSync(DIST), "dist/index.js must be built (npm run build)").toBe(true);
    api = await startFakeApi();
    client = await connect({
      GLINT_API_URL: api.url,
      GLINT_API_KEY: API_KEY,
      GLINT_WEB_URL: WEB_URL,
      GLINT_TIMEOUT_MS: "5000",
    });
  });

  afterAll(async () => {
    await client?.close();
    await api?.close();
  });

  it("lists all tools, the guide resource and the prompt", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "create_agent",
        "draft_strategy",
        "get_agent",
        "get_agent_trades",
        "get_listing",
        "get_platform_config",
        "get_strategy_guide",
        "list_marketplace",
        "list_markets",
        "list_models",
        "list_my_agents",
        "list_presets",
        "stop_agent",
        "validate_strategy",
      ].sort(),
    );
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
    const create = tools.find((t) => t.name === "create_agent")!;
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(["spec", "hlAccount"]));

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("glint://guide/strategy");
    const guide = await client.readResource({ uri: "glint://guide/strategy" });
    const guideText = (guide.contents[0] as { text: string }).text;
    expect(guideText).toContain("maxPositionBps");
    expect(guideText).toContain("spot only");
    expect(guideText).toContain("Glint uses the key only to create orders, cancel and cancel all");
    for (const p of BUILTIN_PRESETS) {
      expect(guideText).toContain(`"${p.key}" (id ${p.id}, ${p.title}`);
      expect(guideText).toContain(`${p.key} = `);
    }
    expect(guideText).toContain("create_agent(spec, hlAccount, allocationUsd)");
    const listPresets = tools.find((t) => t.name === "list_presets")!;
    for (const p of BUILTIN_PRESETS) expect(listPresets.description).toContain(p.key);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("strategy_guide");
  });

  it("list_presets returns presets with paramsSchema and defaults, without prompt templates", async () => {
    const res = await client.callTool({ name: "list_presets", arguments: {} });
    expect(res.isError).toBeFalsy();
    const t = text(res);
    expect(t).toContain('"key": "trend"');
    expect(t).toContain("paramsSchema");
    expect(t).toContain("fastEma");
    expect(t).not.toContain("promptTemplate");

    const one = await client.callTool({ name: "list_presets", arguments: { preset: "dca" } });
    expect(text(one)).toContain("budgetPerBuyBps");
  });

  it("validate_strategy: valid and invalid specs", async () => {
    const good = await client.callTool({ name: "validate_strategy", arguments: { spec: goodSpec } });
    expect(good.isError).toBeFalsy();
    expect(text(good)).toContain("Spec is valid");
    expect(text(good)).toContain('"ok": true');

    const bad = await client.callTool({
      name: "validate_strategy",
      arguments: { spec: { ...goodSpec, markets: ["DOGE"], risk: { ...goodSpec.risk, maxTradeBps: 20000 } } },
    });
    expect(bad.isError).toBeFalsy();
    expect(text(bad)).toContain("INVALID");
    expect(text(bad)).toContain('market "DOGE" is not whitelisted');
    expect(text(bad)).toContain("risk.maxTradeBps must be 1..10000");

    const authHeaders = api.requests.filter((r) => r.path === "/v1/strategies/validate").map((r) => r.auth);
    expect(authHeaders.every((a) => a === `Bearer ${API_KEY}`)).toBe(true);
  });

  it("create_agent returns the signing link with the draft id and instructions", async () => {
    const res = await client.callTool({ name: "create_agent", arguments: { spec: goodSpec, hlAccount: HL_ACCOUNT } });
    expect(res.isError).toBeFalsy();
    const t = text(res);
    expect(t).toContain(`${WEB_URL}/create?draft=${DRAFT_ID}`);
    expect(t).toContain("ChangePubKey");
    expect(t).toContain("ApproveIntegrator");
    expect(t).toContain("Lighter account #21897");
    expect(t).toContain("0.05%");
    expect(t).not.toContain("approveAgent");
    expect(t).toContain("createAgent");
    expect(t).toContain("0x5555555555555555555555555555555555555555");

    const req = api.requests.find((r) => r.path === "/v1/agents/prepare");
    expect(req?.body).toEqual({ spec: goodSpec, hlAccount: HL_ACCOUNT });
  });

  it("create_agent rejects a malformed hlAccount before calling the API", async () => {
    const before = api.requests.length;
    const res = await client.callTool({ name: "create_agent", arguments: { spec: goodSpec, hlAccount: "not-an-address" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/hlAccount|address/);
    expect(api.requests.length).toBe(before);
  });

  it("API errors become readable tool errors", async () => {
    const res = await client.callTool({ name: "get_agent", arguments: { id: 999 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Glint API error 404 (not_found): agent not found");

    const prep = await client.callTool({
      name: "create_agent",
      arguments: { spec: { ...goodSpec, model: "nope" }, hlAccount: HL_ACCOUNT },
    });
    expect(prep.isError).toBe(true);
    expect(text(prep)).toContain("400 (invalid_spec)");
    expect(text(prep)).toContain('model "nope" is not allowed');
  });

  it("other read tools work", async () => {
    expect(text(await client.callTool({ name: "list_models", arguments: {} }))).toContain("test/standard-model");
    expect(text(await client.callTool({ name: "list_markets", arguments: {} }))).toContain("SPY/USDG");
    expect(text(await client.callTool({ name: "list_my_agents", arguments: {} }))).toContain("Trend NVDA");
    expect(text(await client.callTool({ name: "get_agent_trades", arguments: { id: 7, limit: 5 } }))).toContain("EMA cross");
    expect(api.requests.some((r) => r.path === "/v1/agents/7/trades?limit=5")).toBe(true);
    const market = text(await client.callTool({ name: "list_marketplace", arguments: { preset: "trend", sort: "pnl" } }));
    expect(market).toContain("1.5 ETH");
    expect(market).toContain(`${WEB_URL}/marketplace/3`);
    expect(market).toContain("A 5% stop-loss is enforced by code"); // the strategy is visible before buying
    const one = text(await client.callTool({ name: "get_listing", arguments: { id: 3 } }));
    expect(one).toContain("Ride NVDA uptrends");
    expect(one).toContain('"stopLossPct": 5');
    expect(api.requests.some((r) => r.path === "/v1/marketplace?preset=trend&sort=pnl")).toBe(true);
    expect(text(await client.callTool({ name: "stop_agent", arguments: { id: 7 } }))).toContain("stopped");
  });

  it("a missing API key gives a clear message; public tools still work", async () => {
    const noKey = await connect({ GLINT_API_URL: api.url, GLINT_WEB_URL: WEB_URL });
    try {
      const res = await noKey.callTool({ name: "list_my_agents", arguments: {} });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("GLINT_API_KEY is not set");
      const presets = await noKey.callTool({ name: "list_presets", arguments: {} });
      expect(presets.isError).toBeFalsy();
    } finally {
      await noKey.close();
    }
  });

  it("accepts the earlier ELYSIUM_* variable names", async () => {
    const legacy = await connect({ ELYSIUM_API_URL: api.url, ELYSIUM_API_KEY: API_KEY, ELYSIUM_WEB_URL: WEB_URL });
    try {
      const res = await legacy.callTool({ name: "list_my_agents", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(text(res)).toContain("Trend NVDA");
    } finally {
      await legacy.close();
    }
  });

  it("a network error explains that the backend may be down", async () => {
    const port = await deadPort();
    const down = await connect({
      GLINT_API_URL: `http://127.0.0.1:${port}`,
      GLINT_API_KEY: API_KEY,
      GLINT_TIMEOUT_MS: "5000",
    });
    try {
      const res = await down.callTool({ name: "list_presets", arguments: {} });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("Could not reach the Glint API");
      expect(text(res)).toContain("backend may be down");
    } finally {
      await down.close();
    }
  });
});
