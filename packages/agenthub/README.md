# @glint/agenthub

The public interface of the **AgentHub** contract on Robinhood Chain and the encoding of on-chain receipts.

|           |                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Network   | Robinhood Chain mainnet, chain id `4663`                                                                                                 |
| Address   | [`0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c`](https://robinhoodchain.blockscout.com/address/0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c) |
| Interface | [`contracts/IAgentHub.sol`](./contracts/IAgentHub.sol)                                                                                   |
| ABI       | `AGENT_HUB_ABI` / `agentHubAbi` in [`src/abi.ts`](./src/abi.ts)                                                                          |

A test compiles `IAgentHub.sol` with solc and checks that it matches the TypeScript ABI item for item.

The interface declares only what users, clients and auditors need: the agent and marketplace transactions a user
signs, the read functions and the events. Platform configuration and maintenance are not part of it.

## What lives on-chain

- **Agent**: owner, preset id, `specHash`, `modelId`, decision interval, the owner's Lighter account, the address of
  the agent's Lighter API key and the risk limits. The owner sets the status: `Active`, `Paused` or `Stopped` (final).
  Glint uses the key only to create orders, cancel and cancel all; withdrawing isn't part of what the agent does.
- **Listing**: sells locked copies of an agent. `buy` takes the `specHash` the buyer reviewed and reverts with
  `SpecChanged` if the seller changed the strategy in the meantime. The copy keeps the strategy, model and limits
  forever (`locked`). The seller receives 98% of the price; `Purchased.platformFee` is the 2% marketplace share.
- **Receipts**: `TradeRecorded` for every fill and `EpochRecorded` for periodic equity, published in batches by the
  Glint runner. `hlOrderId` is the Lighter order id, so anyone can match a receipt with the account's public trades.
- **Identity**: `AgentIdentitySet` links the agent to its ERC-8004 identity on Robinhood Chain.

The field names `hlAccount`, `apiWallet` and `hlOrderId` are historical and kept for a stable ABI.

## Reading

```ts
import { decodeAgentHubLog, ViemHub } from "@glint/agenthub";

const hub = new ViemHub({ rpcUrls: [process.env.ROBINHOOD_RPC_URL!] }); // defaults to the mainnet deployment
const agent = await hub.getAgent(1);
const logs = await hub.getLogs(111859549n, await hub.blockNumber());
const events = logs.map(decodeAgentHubLog).filter(Boolean);
```

`decodeTradeRecorded(log)` turns a `TradeRecorded` log back into human units for indexers and auditors.

## Writing (the user's own wallet)

```ts
import { AgentHubWriter } from "@glint/agenthub";
import { modelIdOf, specHashOf } from "@glint/strategy";

const writer = new AgentHubWriter(walletClient); // a viem WalletClient of the user
await writer.createAgent({ preset: 2, specHash: specHashOf(spec), modelId: modelIdOf(spec.model), intervalSec: 300, hlAccount, apiWallet, risk });
await writer.setAgentStatus(agentId, 1); // pause
```

## Receipt encoding

```ts
import { batches, MemoryReceiptSink, toTradeReceipt } from "@glint/agenthub";

const receipts = fills.map(toTradeReceipt); // sizeUsd: 6 decimals, priceE8: price * 1e8, market: utf8 bytes32
const sink = new MemoryReceiptSink(); // the runner takes any ReceiptSink
for (const batch of batches(receipts, 100)) await sink.recordTrades(batch);
```

## License

Apache-2.0, see [LICENSE](./LICENSE).
