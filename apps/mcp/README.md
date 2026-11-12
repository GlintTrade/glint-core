# @glint/mcp

An MCP server (stdio) that lets an AI assistant such as Claude Code or Codex create and manage Glint spot-trading
agents on Lighter (Robinhood Chain): pick a preset and markets, build and validate a strategy, prepare an agent,
inspect your agents and their trades, stop an agent, and browse the marketplace.

The server talks to the Glint REST API with your API key.

> **The MCP server never signs transactions and never holds keys.** `create_agent` only prepares a draft and returns
> a link to the website, where you sign everything with your own wallet. Never paste a private key or seed phrase
> into a chat with an AI.

## How it works

1. You tell the assistant what agent you want.
2. The assistant reads presets (`list_presets`, with `paramsSchema` and defaults per risk profile), markets and models,
   builds a `StrategySpec` and checks it with `validate_strategy`.
3. `create_agent(spec, hlAccount, allocationUsd?)` creates a draft on the backend and returns a link
   `<web url>/create?draft=<draftId>`. `hlAccount` is the EVM (L1) address that owns your Lighter account;
   `allocationUsd` is the agent's capital in USDG (minimum 10, recommended at least 30). Presets that never buy
   (Protect) need no capital.
4. You open the link and sign with your own wallet:
   - Lighter `ChangePubKey`: registers the agent's own API key on your Lighter account. Glint uses the key only to
     create orders, cancel and cancel all; withdrawing isn't part of what the agent does;
   - Lighter `ApproveIntegrator`: caps the platform fee per trade (only when a fee is configured; a non-zero fee also
     needs Lighter's Plus tier, which you may decline);
   - the `createAgent` transaction on the AgentHub contract on Robinhood Chain.
5. The website activates the agent. Your funds stay on your own Lighter account the whole time.

## Install

Node.js 20 or newer. From the repository root:

```bash
npm install
npm run build        # builds every package, then apps/mcp/dist/index.js
```

## API key

1. Open <https://tradeglint.xyz>, connect your wallet and sign in.
2. Go to the account page, **API keys**, create a key.
3. Copy the `ek_...` key; it is shown once and can be revoked on the same page.

Without a key only the public tools work (presets, markets, models, config, agents by id, marketplace).

## Environment variables

| Variable           | Default                  | Purpose                                                                             |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------- |
| `GLINT_API_URL`    | `http://localhost:8787`  | Glint REST API base URL (the hosted URL is listed at <https://tradeglint.xyz/docs>) |
| `GLINT_API_KEY`    | none                     | your `ek_...` API key                                                               |
| `GLINT_WEB_URL`    | `https://tradeglint.xyz` | website used in signing links                                                       |
| `GLINT_TIMEOUT_MS` | `60000`                  | API request timeout                                                                 |

Setups made before the rename keep working: the earlier `ELYSIUM_API_URL`, `ELYSIUM_API_KEY`, `ELYSIUM_WEB_URL` and
`ELYSIUM_TIMEOUT_MS` names are still read; `GLINT_*` takes precedence.

## Claude Code

```bash
claude mcp add glint \
  -e GLINT_API_URL=<API URL from https://tradeglint.xyz/docs> \
  -e GLINT_API_KEY=ek_your_key \
  -- node /path/to/glint-core/apps/mcp/dist/index.js
```

Add `-s user` to make it available in every project, or `-s project` to write it to `.mcp.json`.
Check with `claude mcp list` or `/mcp` inside Claude Code.

Or by hand in `.mcp.json`:

```json
{
  "mcpServers": {
    "glint": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/glint-core/apps/mcp/dist/index.js"],
      "env": {
        "GLINT_API_URL": "<API URL from https://tradeglint.xyz/docs>",
        "GLINT_API_KEY": "${GLINT_API_KEY}"
      }
    }
  }
}
```

Do not commit a `.mcp.json` with a real key; `${GLINT_API_KEY}` is expanded from your environment.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.glint]
command = "node"
args = ["/path/to/glint-core/apps/mcp/dist/index.js"]

[mcp_servers.glint.env]
GLINT_API_URL = "<API URL from https://tradeglint.xyz/docs>"
GLINT_API_KEY = "ek_your_key"
```

## Tools

| Tool                                            | What it does                                                         | Key      |
| ----------------------------------------------- | -------------------------------------------------------------------- | -------- |
| `get_strategy_guide`                            | `StrategySpec` reference: fields, limits in bps, spot rules, example | no       |
| `list_presets(preset?)`                         | presets with `paramsSchema` and defaults per risk profile            | no       |
| `list_markets`                                  | whitelisted Lighter spot pairs (SYMBOL/USDG), status and last prices | no       |
| `list_models`                                   | available AI models (`premium` tier for token holders)               | no       |
| `get_platform_config`                           | network, AgentHub address, exchange settings, interval limits        | no       |
| `draft_strategy(prompt, preset?)`               | AI-drafted spec from a plain-language request                        | yes      |
| `validate_strategy(spec)`                       | backend validation: `{ok, errors, specHash}`                         | yes      |
| `create_agent(spec, hlAccount, allocationUsd?)` | agent draft plus a signing link                                      | yes      |
| `list_my_agents`                                | your agents, statuses, PnL                                           | yes      |
| `get_agent(id, includeSpec?)`                   | one agent (the spec is owner-only)                                   | no / yes |
| `get_agent_trades(id, limit?)`                  | trades with the AI's reasons and on-chain receipts                   | no       |
| `stop_agent(id)`                                | stops the agent on the platform (off-chain)                          | yes      |
| `list_marketplace(preset?, sort?)`              | listings with the full strategy a buyer gets                         | no       |
| `get_listing(id)`                               | one listing plus a link to buy it                                    | no       |

There is also the resource `glint://guide/strategy` and the prompt `strategy_guide` (same guide).

`stop_agent` stops trading immediately on the platform side. The final on-chain status `Stopped` is set by the owner
with a `setAgentStatus` transaction on the website. Open positions are not sold automatically.

## Example requests

> Make a trend agent on NVDA and SPY with conservative risk, 50 USDG of capital. My Lighter account is owned by 0xAbc...123.

> DCA into QQQ every 12 hours, never more than 40% of capital in one token, a cheaper model.

> Protect my TSLA: stop 8%, take profit 25%, trailing 6%.

> Show my agents and the last 10 trades of agent #7. Why did it sell NVDA yesterday?

> What trend strategies are on the marketplace? Sort by PnL.

## Errors

- API errors are returned as tool errors, e.g. `Glint API error 400 (invalid_spec): ...` with a hint
  (401: invalid or revoked key, 403: not allowed, 404: not found).
- If the backend is unreachable: `Could not reach the Glint API at ... The backend may be down ...`.
- If a tool needs a key and none is set, the server says so.

## Development

```bash
npm run build -w @glint/mcp   # tsup -> dist/index.js
npx vitest run apps/mcp       # end-to-end: fake HTTP API + MCP client over stdio against dist/index.js
```

The server is self-contained: the API types it relies on are in `src/spec.ts` and `src/api-routes.ts`.
