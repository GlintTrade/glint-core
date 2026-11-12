// Typed AgentHub clients on viem.
//  - HubClient: the narrow read interface the runner, the watchdog and indexers depend on (tests use a fake);
//    ViemHub implements it over JSON-RPC, DisabledHub is used when no AgentHub is configured.
//  - AgentHubWriter: the user-facing transactions, signed by the user's own wallet (create, update, pause or stop an
//    agent, list it, buy a copy).
//  - ReceiptSink: where the runner hands its trade and epoch receipts. Publishing receipts is done by the platform's
//    own signer and is not part of this public package; tests and examples use an in-memory sink.
import {
  type Account,
  type Chain,
  createPublicClient,
  defineChain,
  fallback,
  type Hex,
  http,
  type Log,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { agentHubAbi } from "./abi.js";
import { AGENT_HUB_ADDRESS, MULTICALL3_ADDRESS, ROBINHOOD_CHAIN_ID, ROBINHOOD_EXPLORER_URL, ROBINHOOD_PUBLIC_RPC_URL } from "./deployment.js";
import type { EpochReceipt, TradeReceipt } from "./receipts.js";

/** Risk limits as stored on-chain (bps). */
export interface OnchainRiskBox {
  maxPositionBps: number;
  maxTradeBps: number;
  maxDailyLossBps: number;
  maxTradesPerDay: number;
  durationDays: number;
}

export interface OnchainAgent {
  id: number;
  owner: Hex;
  preset: number;
  locked: boolean;
  status: number; // 0 Active, 1 Paused, 2 Stopped
  intervalSec: number;
  createdAt: number;
  sourceAgentId: number;
  specHash: Hex;
  modelId: Hex;
  hlAccount: Hex; // the owner's Lighter account address (historical ABI name)
  apiWallet: Hex; // address of the agent's Lighter API key (historical ABI name)
  risk: OnchainRiskBox;
}

export interface OnchainListing {
  id: number;
  agentId: number;
  seller: Hex;
  payToken: Hex;
  price: bigint;
  active: boolean;
  sales: number;
}

export interface OnchainIdentity {
  chainId: number;
  registry: Hex;
  erc8004Id: bigint;
}

export interface HubClient {
  readonly enabled: boolean;
  readonly address: Hex;
  getAgent(id: number): Promise<OnchainAgent | null>;
  getListing(id: number): Promise<OnchainListing | null>;
  getIdentity(agentId: number): Promise<OnchainIdentity | null>;
  isPremium(user: Hex): Promise<boolean>;
  blockNumber(): Promise<bigint>;
  /** Every AgentHub log in [fromBlock, toBlock]; decode with decodeAgentHubLog. */
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<Log[]>;
  getBlockTimestamp(blockNumber: bigint): Promise<number>;
  getReceiptLogs(txHash: Hex): Promise<{ logs: Log[]; blockNumber: bigint; status: "success" | "reverted" }>;
}

/** Destination of the runner's receipts (TradeRecorded / EpochRecorded). Returns the transaction hash. */
export interface ReceiptSink {
  readonly enabled: boolean;
  recordTrades(trades: TradeReceipt[]): Promise<Hex>;
  recordEpochs(epochs: EpochReceipt[]): Promise<Hex>;
}

export class ChainUnavailableError extends Error {
  constructor(message = "AgentHub is not configured or the RPC is unavailable") {
    super(message);
    this.name = "ChainUnavailableError";
  }
}

/** Used when no AgentHub is configured: reads fail loudly, isPremium is false. */
export class DisabledHub implements HubClient {
  readonly enabled = false;
  readonly address: Hex = "0x0000000000000000000000000000000000000000";
  private fail(): never {
    throw new ChainUnavailableError();
  }
  getAgent = async (): Promise<OnchainAgent | null> => this.fail();
  getListing = async (): Promise<OnchainListing | null> => this.fail();
  getIdentity = async (): Promise<OnchainIdentity | null> => this.fail();
  isPremium = async () => false;
  blockNumber = async (): Promise<bigint> => this.fail();
  getLogs = async (): Promise<Log[]> => this.fail();
  getBlockTimestamp = async (): Promise<number> => this.fail();
  getReceiptLogs = async (): Promise<{ logs: Log[]; blockNumber: bigint; status: "success" | "reverted" }> => this.fail();
}

/** Receipt sink that keeps receipts in memory (tests, examples, dry runs). */
export class MemoryReceiptSink implements ReceiptSink {
  readonly enabled = true;
  readonly trades: TradeReceipt[] = [];
  readonly epochs: EpochReceipt[] = [];
  private n = 0;
  private hash(): Hex {
    this.n += 1;
    return `0x${this.n.toString(16).padStart(64, "0")}`;
  }
  async recordTrades(trades: TradeReceipt[]): Promise<Hex> {
    this.trades.push(...trades);
    return this.hash();
  }
  async recordEpochs(epochs: EpochReceipt[]): Promise<Hex> {
    this.epochs.push(...epochs);
    return this.hash();
  }
}

export interface ChainOptions {
  /** RPC URLs in priority order (provider first). Default: the public Robinhood Chain RPC. */
  rpcUrls?: readonly string[];
  chainId?: number; // default: Robinhood Chain mainnet (4663)
  chainName?: string;
}

/**
 * viem chain for AgentHub. Arbitrum Nitro pays no priority tips, so maxPriorityFeePerGas = 0 and maxFeePerGas =
 * 2 x base fee (headroom between estimation and inclusion; only the actual base fee is charged).
 */
export function robinhoodChain(o: ChainOptions = {}): Chain {
  const urls = rpcList(o.rpcUrls);
  return defineChain({
    id: o.chainId ?? ROBINHOOD_CHAIN_ID,
    name: o.chainName ?? "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: urls } },
    blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_EXPLORER_URL } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    fees: { baseFeeMultiplier: 2, maxPriorityFeePerGas: 0n },
  });
}

/** Transport that fails over through the RPC list. */
export function rpcTransport(urls: readonly string[], timeoutMs = 15_000, retryCount = 2): Transport {
  return fallback(rpcList(urls).map((u) => http(u, { timeout: timeoutMs, retryCount })));
}

function rpcList(urls?: readonly string[]): string[] {
  const list = [...new Set(urls ?? [])].filter(Boolean);
  return list.length ? list : [ROBINHOOD_PUBLIC_RPC_URL];
}

export interface ViemHubOptions extends ChainOptions {
  /** Default: the mainnet deployment. */
  address?: Hex;
}

export class ViemHub implements HubClient {
  readonly enabled = true;
  readonly address: Hex;
  readonly pub: PublicClient;
  readonly chain: Chain;
  private chainCheck?: Promise<void>;

  constructor(o: ViemHubOptions = {}) {
    this.address = o.address ?? AGENT_HUB_ADDRESS;
    this.chain = robinhoodChain(o);
    this.pub = createPublicClient({ chain: this.chain, batch: { multicall: { wait: 16 } }, transport: rpcTransport(rpcList(o.rpcUrls)) }) as PublicClient;
  }

  /** Checks once that the RPC serves the expected chain (otherwise ChainUnavailableError, never foreign data). */
  private ensureChain(): Promise<void> {
    this.chainCheck ??= this.pub.getChainId().then(
      (id) => {
        if (id !== this.chain.id) throw new ChainUnavailableError(`RPC chain id ${id} does not match ${this.chain.name} (${this.chain.id})`);
      },
      (e) => {
        this.chainCheck = undefined; // network down: check again on the next call
        throw e;
      },
    );
    return this.chainCheck;
  }

  async getAgent(id: number): Promise<OnchainAgent | null> {
    await this.ensureChain();
    try {
      const a = await this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "getAgent", args: [BigInt(id)] });
      if (/^0x0{40}$/i.test(a.owner)) return null;
      return {
        id,
        owner: a.owner,
        preset: Number(a.preset),
        locked: a.locked,
        status: Number(a.status),
        intervalSec: Number(a.intervalSec),
        createdAt: Number(a.createdAt),
        sourceAgentId: Number(a.sourceAgentId),
        specHash: a.specHash,
        modelId: a.modelId,
        hlAccount: a.hlAccount,
        apiWallet: a.apiWallet,
        risk: {
          maxPositionBps: Number(a.risk.maxPositionBps),
          maxTradeBps: Number(a.risk.maxTradeBps),
          maxDailyLossBps: Number(a.risk.maxDailyLossBps),
          maxTradesPerDay: Number(a.risk.maxTradesPerDay),
          durationDays: Number(a.risk.durationDays),
        },
      };
    } catch (e) {
      if (isRevert(e)) return null; // AgentNotFound
      throw e;
    }
  }

  async getListing(id: number): Promise<OnchainListing | null> {
    await this.ensureChain();
    try {
      const l = await this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "getListing", args: [BigInt(id)] });
      if (/^0x0{40}$/i.test(l.seller)) return null;
      return { id, agentId: Number(l.agentId), seller: l.seller, payToken: l.payToken, price: l.price, active: l.active, sales: Number(l.sales) };
    } catch (e) {
      if (isRevert(e)) return null; // ListingNotFound
      throw e;
    }
  }

  async getIdentity(agentId: number): Promise<OnchainIdentity | null> {
    await this.ensureChain();
    const [chainId, registry, erc8004Id] = await this.pub.readContract({
      address: this.address,
      abi: agentHubAbi,
      functionName: "getIdentity",
      args: [BigInt(agentId)],
    });
    if (chainId === 0n && /^0x0{40}$/i.test(registry)) return null;
    return { chainId: Number(chainId), registry, erc8004Id };
  }

  async isPremium(user: Hex): Promise<boolean> {
    await this.ensureChain();
    return this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "isPremium", args: [user] });
  }

  async agentsOf(owner: Hex): Promise<number[]> {
    await this.ensureChain();
    const ids = await this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "agentsOf", args: [owner] });
    return ids.map(Number);
  }

  async agentCount(): Promise<number> {
    await this.ensureChain();
    return Number(await this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "agentCount" }));
  }

  async listingCount(): Promise<number> {
    await this.ensureChain();
    return Number(await this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "listingCount" }));
  }

  async blockNumber(): Promise<bigint> {
    await this.ensureChain();
    // no viem block cache (4 s by default): with short Orbit blocks an indexer would otherwise lag behind
    return this.pub.getBlockNumber({ cacheTime: 0 });
  }

  async getLogs(fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    await this.ensureChain();
    return this.pub.getLogs({ address: this.address, fromBlock, toBlock });
  }

  async getBlockTimestamp(blockNumber: bigint): Promise<number> {
    const b = await this.pub.getBlock({ blockNumber });
    return Number(b.timestamp);
  }

  async getReceiptLogs(txHash: Hex) {
    const r = await this.pub.getTransactionReceipt({ hash: txHash });
    return { logs: r.logs as Log[], blockNumber: r.blockNumber, status: r.status };
  }
}

export interface RiskArgs {
  maxPositionBps: number;
  maxTradeBps: number;
  maxDailyLossBps: number;
  maxTradesPerDay: number;
  durationDays: number;
}

export interface CreateAgentArgs {
  preset: number;
  specHash: Hex;
  modelId: Hex;
  intervalSec: number;
  /** The owner's Lighter account address. */
  hlAccount: Hex;
  /** Address derived from the agent's Lighter API public key. */
  apiWallet: Hex;
  risk: RiskArgs;
}

/**
 * User-facing AgentHub transactions, signed by the user's own wallet client (e.g. from an injected browser wallet).
 * Every method returns the transaction hash; wait for it with `publicClient.waitForTransactionReceipt`.
 */
export class AgentHubWriter {
  constructor(
    private readonly wallet: WalletClient,
    readonly address: Hex = AGENT_HUB_ADDRESS,
  ) {}

  private write(functionName: string, args: readonly unknown[], value?: bigint): Promise<Hex> {
    const account = this.wallet.account as Account | undefined;
    if (!account) throw new Error("wallet client has no account");
    return this.wallet.writeContract({
      address: this.address,
      abi: agentHubAbi,
      functionName: functionName as never,
      args: args as never,
      account,
      chain: this.wallet.chain ?? null,
      ...(value !== undefined ? { value } : {}),
    } as never);
  }

  createAgent(a: CreateAgentArgs): Promise<Hex> {
    return this.write("createAgent", [a.preset, a.specHash, a.modelId, a.intervalSec, a.hlAccount, a.apiWallet, a.risk]);
  }

  updateAgent(agentId: number, a: Pick<CreateAgentArgs, "specHash" | "modelId" | "intervalSec" | "risk">): Promise<Hex> {
    return this.write("updateAgent", [BigInt(agentId), a.specHash, a.modelId, a.intervalSec, a.risk]);
  }

  /** 0 Active, 1 Paused, 2 Stopped (final). */
  setAgentStatus(agentId: number, status: 0 | 1 | 2): Promise<Hex> {
    return this.write("setAgentStatus", [BigInt(agentId), status]);
  }

  setApiWallet(agentId: number, apiWallet: Hex): Promise<Hex> {
    return this.write("setApiWallet", [BigInt(agentId), apiWallet]);
  }

  /** payToken = address(0) for native ETH. ERC-20 listings need an allowance for the buyer at purchase time. */
  createListing(agentId: number, payToken: Hex, price: bigint): Promise<Hex> {
    return this.write("createListing", [BigInt(agentId), payToken, price]);
  }

  updateListing(listingId: number, price: bigint, active: boolean): Promise<Hex> {
    return this.write("updateListing", [BigInt(listingId), price, active]);
  }

  /**
   * Buy a locked copy. `expectedSpecHash` is the strategy hash the buyer reviewed (reverts SpecChanged otherwise).
   * For a native ETH listing pass `value` = the listing price.
   */
  buy(listingId: number, expectedSpecHash: Hex, hlAccount: Hex, apiWallet: Hex, value?: bigint): Promise<Hex> {
    return this.write("buy", [BigInt(listingId), expectedSpecHash, hlAccount, apiWallet], value);
  }
}

function isRevert(e: unknown): boolean {
  const err = e as { name?: string; shortMessage?: string; message?: string };
  const msg = String(err?.shortMessage ?? err?.message ?? "");
  return err?.name === "ContractFunctionExecutionError" && /revert/i.test(msg);
}
