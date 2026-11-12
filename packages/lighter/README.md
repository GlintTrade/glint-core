# @glint/lighter

The [Lighter](https://docs.lighter.xyz) connection layer for spot markets on Robinhood Chain (Lighter RH): REST
client, market data, order formatting, the WASM signer wiring and the API-key onboarding format.

## Trust model in code

- **Glint uses the key only to create orders, cancel and cancel all; withdrawing isn't part of what the agent does.**
  A Lighter API key is a general-purpose L2 key and Lighter has no per-key scopes, so the scope is enforced in code:
  - `loadLighterSigner` (`wasm.ts`) copies only allowlisted WASM functions into two frozen capabilities and deletes
    every function the WASM registered from `globalThis`. The **agent capability** exposes only `CreateClient`,
    `SignCreateOrder`, `SignCancelOrder`, `SignCancelAllOrders` and `CreateAuthToken`.
  - `AgentSigner` (`agent-signer.ts`) re-checks that allowlist on every call and refuses any signed result whose tx
    type is not create order (14), cancel order (15) or cancel all (16).
  - `LighterClient` sends agent transactions to `sendTx` only for those three tx types.
- **Onboarding is separate** (`onboarding.ts`): key generation, `ChangePubKey` and `ApproveIntegrator`. Every
  submission needs a `personal_sign` signature of the **user's own wallet**, verified against the account's L1
  address before anything is sent. The runner never touches the onboarding capability.
- Auth tokens are attached only to an allowlist of GET reads (`AUTH_GET_PATHS` in `http.ts`), never to an endpoint
  that changes anything.
- Nonces are serialised per API key (`nonce.ts`): read `nextNonce`, sign, send and confirm, then the next transaction.

## The WASM signer (not included)

Signing uses the official Lighter signer compiled from
[`elliottech/lighter-go`](https://github.com/elliottech/lighter-go) (`wasm/main.go`). The binary is **not part of
this repository**; build it from pinned source:

```bash
sh packages/lighter/scripts/build-lighter-signer.sh
# -> packages/lighter/vendor/lighter-signer/lighter-signer.wasm and wasm_exec.js
```

The script uses a local Go 1.25.5, or the `golang:1.25.5` Docker image when Go is missing. The build is
reproducible (`-trimpath`), and `loadLighterSigner` refuses any file whose sha256 is not pinned in
[`src/lighter/signer-pin.ts`](src/lighter/signer-pin.ts):

| Pin                     | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| lighter-go tag          | `v1.0.12`                                                          |
| lighter-go commit       | `324c93b067f24ede24918f3ac10663605d5f11c3`                         |
| Go version              | `1.25.5`                                                           |
| `lighter-signer.wasm`   | `550f978b39c822cdbc99f3d7bf02418b1d4a89c757374fb1217b54c19806964a` |
| `wasm_exec.js` (Go lib) | `0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14` |

`defaultSignerFiles()` points at `packages/lighter/vendor/lighter-signer/`; pass your own `SignerFiles` to load it
from elsewhere. Tests that need the real WASM are skipped when it is absent; everything else runs against a fake
WASM.

## Contents

| Module                    | What it does                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `types.ts`                | `ExchangeClient` interface, candles, L2 book (`OrderBook`, `BookLevel`), balances, fills, orders                   |
| `lighter/client.ts`       | `LighterClient`: orderBookDetails, candles, orderBookOrders, accounts, API keys, nonces, fills, IOC orders         |
| `lighter/http.ts`         | REST transport with retries, platform read token and the auth-token allowlist                                      |
| `lighter/agent-signer.ts` | the only module that signs with an agent key: create order, cancel, cancel all, auth token                         |
| `lighter/wasm.ts`         | loads the sha256-pinned WASM and splits it into the agent and onboarding capabilities                              |
| `lighter/onboarding.ts`   | `ChangePubKey` / `ApproveIntegrator` messages and submissions, gated on the user's L1 signature                    |
| `lighter/keys.ts`         | API-key slots on RH, the `apiWallet` fingerprint stored in AgentHub, the onboarding-row format and store interface |
| `lighter/nonce.ts`        | per-key mutex and the uint48 client order index                                                                    |
| `format.ts`               | prices and sizes to `price_decimals` / `size_decimals` with directional rounding; exact scaling to signer integers |
| `markets.ts`              | every USDG spot pair from orderBookDetails, liquidity tiers, open/closed state (status, freeze, trading window)    |
| `network.ts`              | Lighter RH endpoints and chain ids, `createExchange` factory                                                       |

## Agent key format (AgentHub mapping)

An agent is bound on-chain to exactly one Lighter API key:

- `hlAccount` (field name kept for ABI compatibility) is the user's L1 (EVM) address that owns the Lighter account;
  the Lighter `account_index` is resolved from it.
- `apiWallet` is the first 20 bytes of `keccak256` of the raw 40-byte Lighter API public key (`apiWalletOf`).
- The key sits in a free slot (`pickFreeKeyIndex`): 4–156 or 158–254 on RH, picked from the top.

```ts
import { createExchange, LIGHTER_RH } from "@glint/lighter";

const { exchange } = createExchange({ ...LIGHTER_RH.mainnet, integratorAccountIndex: null });
const markets = await exchange.spotMarkets(); // public reads need no signer
const book = await exchange.l2Book("NVDA/USDG");
```

## License

BUSL-1.1, see [LICENSE](./LICENSE).
