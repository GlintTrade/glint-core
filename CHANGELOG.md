# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-11-12

First public release of the Glint core.

### Added

- `@glint/strategy`: `StrategySpec` types (quoted in USDG), strict validation, canonical JSON and `specHash` /
  `modelId`, built-in presets DCA, Protect, Trend, Rebalance and Momentum, display units, Robinhood Chain constants.
- `@glint/indicators`: EMA, RSI, change and volatility with per-timeframe candle batching and parameter overrides.
- `@glint/lighter`: Lighter REST client, spot market metadata and market status, size and price formatting, nonce
  management, the WASM signer loader with sha256 pinning and a capability split (agent code can only create orders,
  cancel and cancel all), API-key onboarding format (`ChangePubKey`, `ApproveIntegrator`) and checks.
- `@glint/risk`: deterministic risk engine with stable rejection codes, preset rules (buy interval and budget,
  buy-below price, indicator entry and exit conditions, position cap, rebalance targets), closed-market handling,
  protective stops and an order-book liquidity guard with strict and clip modes.
- `@glint/runner`: decision loop with dependency injection, LLM layer (prompt, decision schema, OpenAI-compatible
  provider, router with fallback and protect-only mode), capital sub-accounts for several agents on one Lighter
  account, partner-fee handling, trade and epoch receipts, watchdog, AES-256-GCM key vault, in-memory store.
- `@glint/agenthub`: `IAgentHub.sol`, the user-facing and read interface of the AgentHub contract on Robinhood Chain
  (`0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c`), ABI verified against the interface with solc, typed viem client,
  receipt encoding and decoding.
- `@glint/erc8004`: registration file, Identity Registry client and the register, transfer and link job.
- `@glint/mcp`: MCP server for Claude Code, Codex and other MCP clients.
- Examples, security policy and contribution guide.

[Unreleased]: https://github.com/GlintTrade/glint-core/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/GlintTrade/glint-core/releases/tag/v0.1.0
