# @glint/runner

The agent decision loop: market snapshot, LLM decision layer, risk engine, liquidity guard, execution with the
agent's Lighter API key, protective stops, capital sub-accounts, on-chain receipts and an independent watchdog.

Glint uses the key only to create orders, cancel and cancel all; withdrawing isn't part of what the agent does.

## One tick of one agent

1. **Gate.** Skip unless the agent is activated, `Active` in AgentHub with the same `apiWallet`, its API key is
   registered on the user's Lighter account at its slot (`checkLighterApprovals`), and it is not paused off-chain.
2. **Snapshot.** Free spot balances (USDG and tokens), mid prices (book mid for held positions), the agent's capital
   sub-account (`capital/ledger.ts`) and its market set (`universe.ts`: selected pairs or the `"*"` shortlist plus held
   positions). Markets closed or halted on Lighter (status not active, frozen, outside the window) are not buyable.
3. **Protective exits by code.** Stop-loss, take-profit, trailing stop (`preset.protection`) and preset exit rules
   (`preset.rules.exitWhen`) run on every tick, without the AI. Orders go through the liquidity guard in clip mode.
4. **Decision, when due.** If `intervalSec` has passed and a cheap trigger fires (price move, near a stop, schedule,
   heartbeat), the runner builds a prompt with shares and percentages only (no addresses, no USD amounts),
   asks the model for JSON, validates it, and passes it to the **risk engine** (`@glint/risk`). Only approved orders
   are sent, after the order-book liquidity check in strict mode.
5. **Execution.** IOC limit orders signed by the agent's Lighter API key (`@glint/lighter`). Lighter charges spot fees
   in the received asset, so a buy is recorded net of fees. The platform's partner attribution is attached only with
   the user's `ApproveIntegrator`; a non-zero platform fee only on Plus/Premium accounts. A missing approval never
   stops the agent: it trades with a zero platform fee and `state.feeMode` says so.
6. **Receipts.** Filled trades become `TradeRecorded`, hourly equity becomes `EpochRecorded` (`@glint/agenthub`
   receipt encoding), written through an injected `ReceiptSink`.

If every AI provider fails, the decision is `hold` for that tick, the feed says why ("AI unavailable: timeout"), and the
next decision is asked normally. Stops keep running in any case.

## Dependency injection

```ts
import { createExchange, MemoryLighterKeyStore } from "@glint/lighter";
import { EncryptedKeyVault, LlmRouter, loadIntegratorConfig, loadLlmFromEnv, loadRunnerConfig, MemoryStore, Runner } from "@glint/runner";

const store = new MemoryStore({ models }); // or your own RunnerStore on a database
const keyRows = new MemoryLighterKeyStore(); // onboarding rows: account index and API key slot per agent key
const { exchange } = createExchange({ api, chainId, isTestnet: false, integratorAccountIndex: null });
const llm = new LlmRouter({ providers: loadLlmFromEnv(), models: () => store.listModels(), usage: store });
const keys = new EncryptedKeyVault(process.env.MASTER_KEY!, keyRows); // AES-256-GCM, bound to the apiWallet
const runner = new Runner({ store, exchange, keyRows, hub, receipts, llm, keys, config: loadRunnerConfig(), integrator: loadIntegratorConfig() });
runner.start();
```

| Dependency     | Interface                            | Provided implementation                                     |
| -------------- | ------------------------------------ | ----------------------------------------------------------- |
| Persistence    | `RunnerStore`                        | `MemoryStore`                                               |
| Lighter        | `ExchangeClient` (`@glint/lighter`)  | `LighterClient` via `createExchange`                        |
| Key slots      | `LighterKeyStore` (`@glint/lighter`) | `MemoryLighterKeyStore`                                     |
| AgentHub reads | `HubClient` (`@glint/agenthub`)      | `ViemHub`, `DisabledHub`                                    |
| Receipts       | `ReceiptSink` (`@glint/agenthub`)    | `MemoryReceiptSink` (bring your own on-chain writer)        |
| AI             | `LlmProvider`                        | `OpenAiCompatibleProvider` (any OpenAI-compatible endpoint) |
| Agent keys     | `KeyVault`                           | `EncryptedKeyVault`                                         |
| Alerts         | `Alerter`                            | `LogAlerter`                                                |
| Logging        | `Logger` (pino-compatible)           | `consoleLogger` (redacts secrets), `noopLogger`             |

## Environment

| Variable                                                                       | Default              | Meaning                                                                     |
| ------------------------------------------------------------------------------ | -------------------- | --------------------------------------------------------------------------- |
| `LLM_BASE_URL`, `LLM_API_KEY`                                                  | required             | OpenAI-compatible endpoint for decisions                                    |
| `LLM_PROVIDER_NAME`                                                            | `openai-compatible`  | must match `ModelInfo.provider` of your models                              |
| `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_MODEL`          | unset                | optional second endpoint                                                    |
| `LLM_TIMEOUT_MS`                                                               | `25000`              | per request                                                                 |
| `RUNNER_TICK_SEC`                                                              | `15`                 | tick period                                                                 |
| `RECEIPTS_FLUSH_SEC` / `EPOCH_SEC`                                             | `30` / `3600`        | receipt batching                                                            |
| `TRIGGER_MOVE_PCT` / `TRIGGER_HEARTBEAT_SEC`                                   | `0.3` / `3600`       | cheap triggers                                                              |
| `MAX_SLIPPAGE_BPS` / `MIN_ORDER_USD`                                           | `100` / `10`         | order limits (Lighter minimum order: 10 USDG)                               |
| `MAX_SPREAD_BPS` / `MAX_ORDER_PCT_OF_DAY_VOLUME` / `MIN_MARKET_DAY_VOLUME_USD` | `150` / `2` / `5000` | liquidity guard; pairs above the volume threshold are enabled automatically |
| `LIGHTER_INTEGRATOR_ACCOUNT_INDEX`                                             | unset                | platform partner account (unset: no platform fee)                           |
| `LIGHTER_INTEGRATOR_SPOT_TAKER_FEE` / `..._MAKER_FEE`                          | `0` / `0`            | millionths (100 = 1 bp), at most 20000                                      |
| `LIGHTER_INTEGRATOR_REQUIRED`                                                  | `true`               | activation requires the integrator approval                                 |
| `DRY_RUN`                                                                      | `false`              | log orders instead of sending them                                          |

## Tests

`npx vitest run packages/runner` from the repository root. The tests run the full loop against in-memory fakes of
Lighter, AgentHub and the LLM; no network, no WASM.

## License

BUSL-1.1, see [LICENSE](./LICENSE).
