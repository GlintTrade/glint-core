# Contributing

Thanks for your interest in Glint. Issues and pull requests are welcome.

## Before you start

- Security issues go to an X direct message to [@Glint_Trade](https://x.com/Glint_Trade), never to a public issue. See [SECURITY.md](SECURITY.md).
- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Contributions to BUSL-1.1 packages are accepted under the same license; contributions to Apache-2.0 packages
  (`packages/agenthub`, `apps/mcp`) under Apache-2.0. By opening a pull request you confirm that you have the right to
  submit the code under the license of the package you change.

## Setup

```bash
npm install
npm run build
npm test
```

Node.js 22 or newer. Tests never touch the network: Lighter, AgentHub and model providers are faked, and the WASM signer is not needed.

## Rules of the codebase

- **The risk engine is pure and deterministic.** No I/O, no clock, no randomness inside `evaluateDecision` or
  `checkLiquidity`. Every new limit gets a stable rejection code and a test.
- **No preset-specific branches.** Presets are data (`indicators`, `rules`, `protection`, `promptTemplate`). If a new
  behavior is needed, add a generic rule type that any preset can use.
- **The spec hash is a contract.** Changes to `StrategySpec` or `canonicalJson` change `specHash` values that are
  already on-chain. They need a version bump and a migration note.
- **The prompt contains no addresses and no balances in USD.** Shares in bps and percentages only.
- **Interfaces at the edges.** New external systems are injected through an interface with an in-memory
  implementation for tests.

## Pull requests

- Keep them focused; one change per pull request.
- `npm run lint`, `npm run typecheck`, `npm run build` and `npm test` must pass.
- Add or update tests next to the code you change and update the package README if behavior changes.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under "Unreleased".
