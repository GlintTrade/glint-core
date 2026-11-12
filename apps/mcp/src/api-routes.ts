// The subset of the Glint REST API (base path /v1) used by the MCP server.
// Errors: HTTP status + ApiError { error: { code, message } }.
// Auth: "Bearer ek_..." API key created on the website account page.

export const API_ROUTES = {
  // public
  config: { method: "GET", path: "/v1/config", auth: "none" }, // -> PublicConfig
  markets: { method: "GET", path: "/v1/markets", auth: "none" }, // -> { markets: (MarketInfo & { midUsd })[] }
  presets: { method: "GET", path: "/v1/presets", auth: "none" }, // -> { presets: PresetInfo[] }
  agent: { method: "GET", path: "/v1/agents/:id", auth: "none" }, // -> AgentView
  agentTrades: { method: "GET", path: "/v1/agents/:id/trades", auth: "none" }, // ?limit=50 -> { trades: TradeView[] }
  marketplace: { method: "GET", path: "/v1/marketplace", auth: "none" }, // ?preset=&sort=pnl|sales|new -> { listings: ListingView[] }
  listing: { method: "GET", path: "/v1/marketplace/:id", auth: "none" }, // -> ListingView

  // signed-in (API key)
  strategyValidate: { method: "POST", path: "/v1/strategies/validate", auth: "any" }, // { spec } -> { ok, errors, specHash }
  strategyDraft: { method: "POST", path: "/v1/strategies/draft", auth: "any" }, // { prompt, preset? } -> { spec }
  agentPrepare: { method: "POST", path: "/v1/agents/prepare", auth: "any" }, // { spec, hlAccount, allocationUsd? } -> PrepareAgentResponse
  agentStop: { method: "POST", path: "/v1/agents/:id/stop", auth: "any" }, // -> { ok } (off-chain stop)
  agentSpec: { method: "GET", path: "/v1/agents/:id/spec", auth: "any" }, // -> { spec, locked } (owner only)
  account: { method: "GET", path: "/v1/account", auth: "any" }, // -> { address, isPremium, agents: AgentView[] }
} as const;
