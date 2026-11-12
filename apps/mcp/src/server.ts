// MCP tools, resource and prompt.
// IMPORTANT: the server never signs transactions and never holds keys: it only reads the API and prepares drafts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiClient, describeError } from "./api";
import type { Config } from "./config";
import { strategyGuideText } from "./guide";
import { AddressSchema, IdSchema, StrategySpecSchema } from "./schemas";
import {
  type AgentView,
  type ListingView,
  type MarketInfo,
  NATIVE_TOKEN,
  type PrepareAgentResponse,
  type PresetInfo,
  type PublicConfig,
  type StrategySpec,
  type TradeView,
} from "./spec";

export const SERVER_NAME = "glint";
export const SERVER_VERSION = "0.1.0";
const GUIDE_URI = "glint://guide/strategy";

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function ok(text: string, data?: unknown): CallToolResult {
  return { content: [{ type: "text", text: data === undefined ? text : `${text}\n\n${json(data)}` }] };
}

function fail(e: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: describeError(e) }] };
}

async function safe(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

/** Base units to a human amount (ETH has 18 decimals, USDG 6). */
export function formatPrice(price: string, payToken: string): string {
  const isNative = payToken.toLowerCase() === NATIVE_TOKEN;
  const decimals = isNative ? 18 : 6;
  const symbol = isNative ? "ETH" : "USDG";
  try {
    const v = BigInt(price);
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole}${frac ? "." + frac : ""} ${symbol}`;
  } catch {
    return `${price} (base units)`;
  }
}

function withPrice(l: ListingView, webUrl: string) {
  return { ...l, priceFormatted: formatPrice(l.price, l.payToken), url: `${webUrl}/marketplace/${l.id}` };
}

export function createServer(cfg: Config, api: ApiClient = new ApiClient(cfg)): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Glint: create and manage AI spot-trading agents on Lighter (Robinhood Chain): tokenized stocks, ETFs and ETH quoted in USDG. Read get_strategy_guide (or the strategy_guide resource) before building a StrategySpec. " +
        "This server never signs transactions and never holds keys: create_agent only returns a link where the user signs with their own wallet. Never ask for private keys or seed phrases.",
    },
  );

  // ---------- guide ----------

  server.registerResource(
    "strategy_guide",
    GUIDE_URI,
    {
      title: "StrategySpec guide",
      description: "How to build a Glint StrategySpec: fields, risk limits in bps, spot-only rules, presets, example spec.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: strategyGuideText() }] }),
  );

  server.registerPrompt(
    "strategy_guide",
    {
      title: "Build a Glint trading agent",
      description: "Guide for turning a user's request into a valid Glint StrategySpec and creating the agent.",
      argsSchema: { request: z.string().optional().describe("What the user wants the agent to do") },
    },
    ({ request }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: strategyGuideText() + (request ? `\n\n## User request\n${request}\n\nBuild the spec, validate it, then call create_agent.` : ""),
          },
        },
      ],
    }),
  );

  server.registerTool(
    "get_strategy_guide",
    {
      title: "Strategy guide",
      description:
        "Returns the StrategySpec format reference: fields, risk limits (bps), spot-only rules, built-in presets and an example spec. Call this before building a spec by hand.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok(strategyGuideText()),
  );

  // ---------- platform catalog ----------

  server.registerTool(
    "list_presets",
    {
      title: "List strategy presets",
      description:
        "Lists enabled strategy presets (e.g. dca, protect, trend, rebalance, momentum) with what they may do (allowsBuy/allowsSell), indicators, " +
        "paramsSchema (exact keys/types/ranges for spec.params) and defaults per risk profile (risk + params). " +
        "Use the defaults of the chosen profile as the starting point of a StrategySpec. Optionally pass `preset` to get one preset.",
      inputSchema: { preset: z.string().optional().describe("Preset key to return only that preset") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ preset }) =>
      safe(async () => {
        const { presets } = await api.call<{ presets: PresetInfo[] }>("presets");
        const list = presets.filter((p) => p.enabled !== false).map(({ promptTemplate: _t, ...rest }) => rest);
        if (preset) {
          const one = list.find((p) => p.key === preset);
          if (!one) {
            return fail(new Error(`preset "${preset}" not found. Available: ${list.map((p) => p.key).join(", ") || "none"}`));
          }
          return ok(`Preset "${preset}":`, one);
        }
        return ok(`${list.length} preset(s). spec.params must follow each preset's paramsSchema.`, list);
      }),
  );

  server.registerTool(
    "list_markets",
    {
      title: "List spot markets",
      description:
        'Lists enabled (liquid) Lighter spot markets on Robinhood Chain (symbol, pair vs USDG, market id, decimals, status/open, 24h volume in USDG, last price). Only these symbols can be used in spec.markets - or use ["*"] alone for all liquid pairs. Markets with open=false are closed or halted: no buys.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      safe(async () => {
        const { markets } = await api.call<{ markets: (MarketInfo & { midUsd: number })[] }>("markets");
        const list = markets.filter((m) => m.enabled !== false);
        return ok(`${list.length} spot market(s) on Lighter, quote USDG:`, list);
      }),
  );

  server.registerTool(
    "list_models",
    {
      title: "List AI models",
      description: "Lists AI models an agent can use (spec.model = id). tier 'premium' models are only available to utility-token holders.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      safe(async () => {
        const cfgRes = await api.call<PublicConfig>("config");
        const models = (cfgRes.models ?? []).filter((m) => m.enabled !== false);
        return ok(`${models.length} model(s). Use "id" as spec.model:`, models);
      }),
  );

  server.registerTool(
    "get_platform_config",
    {
      title: "Platform config",
      description:
        "Returns public platform config: chain id, AgentHub address, exchange (Lighter on Robinhood Chain: api, signing chain id, quote USDG, integrator account and platform fee), decision interval limits (min, premiumMin, default, options), presets, markets, models.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      safe(async () => {
        const c = await api.call<PublicConfig>("config");
        return ok("Glint platform config:", c);
      }),
  );

  // ---------- strategies ----------

  server.registerTool(
    "draft_strategy",
    {
      title: "Draft a strategy with AI",
      description:
        "Asks the backend AI assistant to draft a StrategySpec from a natural-language request (e.g. 'trend agent on NVDA and SPY with conservative risk'). " +
        "Returns a spec to review/adjust with the user, then pass to validate_strategy and create_agent. Requires an API key (GLINT_API_KEY).",
      inputSchema: {
        prompt: z.string().min(1).describe("The user's request in natural language (any language)"),
        preset: z.string().optional().describe("Optional preset key to force (from list_presets)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ prompt, preset }) =>
      safe(async () => {
        const res = await api.call<{ spec: StrategySpec }>("strategyDraft", { body: { prompt, preset } });
        return ok(
          "Draft StrategySpec (nothing is created yet). Check model, markets and risk with the user, then call validate_strategy and create_agent:",
          res.spec,
        );
      }),
  );

  server.registerTool(
    "validate_strategy",
    {
      title: "Validate a strategy spec",
      description:
        "Validates a StrategySpec on the backend (preset exists, markets whitelisted, model allowed, risk bps in range, params match paramsSchema, interval allowed). " +
        "Returns {ok, errors[], specHash}. Fix all errors before create_agent. Requires an API key (GLINT_API_KEY).",
      inputSchema: { spec: StrategySpecSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ spec }) =>
      safe(async () => {
        const res = await api.call<{ ok: boolean; errors: string[]; specHash?: string }>("strategyValidate", {
          body: { spec },
        });
        if (res.ok) return ok("Spec is valid. You can now call create_agent(spec, hlAccount, allocationUsd).", res);
        return ok(`Spec is INVALID (${res.errors?.length ?? 0} error(s)). Fix them and validate again:\n- ${(res.errors ?? []).join("\n- ")}`, res);
      }),
  );

  // ---------- agents ----------

  server.registerTool(
    "create_agent",
    {
      title: "Create agent (prepare draft)",
      description:
        "Prepares a new agent from a validated StrategySpec for the user's Lighter (Robinhood Chain) account and returns a link to the Glint website. " +
        "It does NOT sign anything or move funds: the user must open the link and sign with their own wallet " +
        "(1) Lighter ChangePubKey registering the agent's API key, (2) Lighter ApproveIntegrator for the platform fee (when one is set; optional Plus-tier consent), (3) createAgent transaction on AgentHub (Robinhood Chain). " +
        "Always show the returned link and these steps to the user. Requires an API key (GLINT_API_KEY).",
      inputSchema: {
        spec: StrategySpecSchema,
        hlAccount: AddressSchema.describe(
          "The user's EVM (L1) address that owns their Lighter account on Robinhood Chain (0x...) - the wallet they will sign with. The account must exist (first USDG deposit). Ask the user if unknown; never guess.",
        ),
        allocationUsd: z
          .number()
          .positive()
          .optional()
          .describe(
            "How much USDG of the user's Lighter account this agent may use (its own capital; several agents can share one account). " +
              "Required for presets that buy when the account already has other agents. Minimum 10, recommended at least 30. Ask the user; never guess.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ spec, hlAccount, allocationUsd }) =>
      safe(async () => {
        const res = await api.call<PrepareAgentResponse>("agentPrepare", {
          body: { spec, hlAccount, ...(allocationUsd !== undefined ? { allocationUsd } : {}) },
        });
        const link = `${cfg.webUrl}/create?draft=${encodeURIComponent(res.draftId)}`;
        const text = [
          `Agent draft created: ${res.draftId}. Nothing is on-chain yet and no funds were moved.`,
          "",
          `Open this link with the wallet that controls ${hlAccount}:`,
          link,
          "",
          "On that page the user signs in their OWN wallet:",
          `1. Lighter ChangePubKey - registers the agent's API key (${res.agentName} on Lighter account #${res.lighter?.accountIndex ?? "?"}; AgentHub apiWallet ${res.apiWallet}). Glint uses the key only to create orders, cancel and cancel all; withdrawing isn't part of what the agent does.`,
          res.lighter?.approveIntegrator
            ? `2. Lighter ApproveIntegrator - allows the platform (integrator account #${res.lighter.approveIntegrator.integratorAccountIndex}) to take up to ${res.lighter.approveIntegrator.feePct} per trade. A non-zero fee also needs Lighter's Plus tier (0.015% Lighter fee); the user may decline and the agent runs with no platform fee.`
            : "2. (no platform fee is configured: nothing to approve)",
          `3. createAgent transaction on AgentHub (presetId ${res.presetId}, specHash ${res.specHash}, interval ${res.intervalSec}s) - registers the agent on-chain.`,
          "After these, the site activates the agent. The account needs USDG on Lighter (Robinhood Chain) to trade.",
          "This MCP server never signs transactions or holds keys - never ask the user for a private key or seed phrase.",
        ].join("\n");
        return ok(text, { link, ...res });
      }),
  );

  server.registerTool(
    "list_my_agents",
    {
      title: "List my agents",
      description:
        "Lists agents owned by the API key's account (status, preset, risk, model, stats such as PnL and trade count), plus premium status. Requires an API key (GLINT_API_KEY).",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      safe(async () => {
        const acc = await api.call<{ address: string; isPremium: boolean; agents: AgentView[] }>("account");
        return ok(`Account ${acc.address}: ${acc.agents?.length ?? 0} agent(s). Premium: ${acc.isPremium ? "yes" : "no"}.`, {
          address: acc.address,
          isPremium: acc.isPremium,
          agents: acc.agents ?? [],
        });
      }),
  );

  server.registerTool(
    "get_agent",
    {
      title: "Get agent",
      description:
        "Returns one agent by id: owner, preset, status (active/paused/stopped), locked (bought on marketplace), risk limits, model, stats. " +
        "Set includeSpec=true to also fetch the full StrategySpec (owner only, needs an API key; for a purchased copy it is read-only).",
      inputSchema: {
        id: IdSchema.describe("Agent id"),
        includeSpec: z.boolean().optional().describe("Also return the agent's StrategySpec (owner only)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id, includeSpec }) =>
      safe(async () => {
        const agent = await api.call<AgentView>("agent", { params: { id } });
        if (!includeSpec) return ok(`Agent #${id}:`, agent);
        let spec: unknown;
        try {
          spec = (await api.call<{ spec: StrategySpec }>("agentSpec", { params: { id } })).spec;
        } catch (e) {
          spec = { unavailable: describeError(e) };
        }
        return ok(`Agent #${id}:`, { ...agent, spec });
      }),
  );

  server.registerTool(
    "get_agent_trades",
    {
      title: "Get agent trades",
      description: "Returns recent trades of an agent (side, market, size USD, price, AI reason, time, on-chain receipt tx). Newest first.",
      inputSchema: {
        id: IdSchema.describe("Agent id"),
        limit: z.number().int().min(1).max(500).optional().describe("Max trades to return (default 50)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id, limit }) =>
      safe(async () => {
        const { trades } = await api.call<{ trades: TradeView[] }>("agentTrades", {
          params: { id },
          query: { limit: limit ?? 50 },
        });
        return ok(`${trades.length} trade(s) of agent #${id}:`, trades);
      }),
  );

  server.registerTool(
    "stop_agent",
    {
      title: "Stop agent",
      description:
        "Stops an agent immediately on the platform side (the runner stops trading for it). Only the agent owner can do this. " +
        "This is an off-chain stop; to set the final on-chain status Stopped the owner signs setAgentStatus on the website Account page. " +
        "Confirm with the user before calling. Requires an API key (GLINT_API_KEY).",
      inputSchema: { id: IdSchema.describe("Agent id") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ id }) =>
      safe(async () => {
        const res = await api.call<{ ok: boolean }>("agentStop", { params: { id } });
        return ok(
          `Agent #${id} stopped on the platform (off-chain). Open ${cfg.webUrl}/account to also set the on-chain status (setAgentStatus → Stopped) with your wallet; ` +
            "Stopped is final on-chain. Funds stay on the user's Lighter account; open positions are not sold automatically.",
          res,
        );
      }),
  );

  // ---------- marketplace ----------

  server.registerTool(
    "list_marketplace",
    {
      title: "List marketplace",
      description:
        "Lists marketplace listings of agents for sale: title, blurb, preset, risk, markets, stats (PnL, win rate, drawdown), sales and price, " +
        "plus `strategy` - the full strategy the buyer gets: a plain-language description, the author's goal, preset params (raw units: *Bps = bps, *Sec = seconds), " +
        "risk limits, markets, AI model and decision interval (`synced: false` = the author changed it and has not synced it on-chain; it cannot be bought until then). " +
        "The whole strategy is shown before buying; the bought copy is locked (frozen) on the buyer's own Lighter account. Buying is done on the website (link in each listing).",
      inputSchema: {
        preset: z.string().optional().describe("Filter by preset key"),
        sort: z.enum(["pnl", "sales", "new"]).optional().describe("Sort order (default chosen by the backend)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ preset, sort }) =>
      safe(async () => {
        const { listings } = await api.call<{ listings: ListingView[] }>("marketplace", { query: { preset, sort } });
        return ok(
          `${listings.length} listing(s). Buying happens on the website (url), the user signs with their wallet.`,
          listings.map((l) => withPrice(l, cfg.webUrl)),
        );
      }),
  );

  server.registerTool(
    "get_listing",
    {
      title: "Get listing",
      description:
        "Returns one marketplace listing by id with stats, price, the website link to buy it and `strategy`: the full strategy the buyer gets " +
        "(description, goal, preset params in raw units - *Bps = bps, *Sec = seconds - risk limits, markets, model, decision interval).",
      inputSchema: { id: IdSchema.describe("Listing id") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) =>
      safe(async () => {
        const l = await api.call<ListingView>("listing", { params: { id } });
        return ok(`Listing #${id}. To buy, the user opens the url and signs with their own wallet:`, withPrice(l, cfg.webUrl));
      }),
  );

  return server;
}
