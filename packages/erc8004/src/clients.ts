// Network clients for ERC-8004: the Identity Registry and the identity link in AgentHub, both on Robinhood Chain.
// The interfaces are small so the job can be tested with fakes and no network.
// The registering key belongs to the platform: it pays gas for register(), then hands the NFT to the agent owner.
import { AGENT_HUB_ADDRESS, agentHubAbi, MULTICALL3_ADDRESS, ROBINHOOD_CHAIN_ID, robinhoodChain, rpcTransport } from "@glint/agenthub";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, type PublicClient, toHex, type WalletClient } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { identityRegistryAbi } from "./abi.js";
import type { Erc8004Config, Hex } from "./config.js";

export type TxState = { state: "pending" } | { state: "reverted" } | { state: "success"; logs?: unknown };

export interface MetadataEntry {
  metadataKey: string;
  metadataValue: Hex;
}

export interface IdentityRegistryClient {
  readonly chainId: number;
  readonly registry: Hex;
  /** Address of the registering key. */
  readonly signer: Hex;
  /** The registry accepts register(): an eth_call simulation from the registering key succeeds. */
  isAvailable(): Promise<boolean>;
  /** Whether the registering key has enough native token (ETH) for register (gas estimate x price x 2, as maxFeePerGas headroom). */
  hasGas(): Promise<boolean>;
  sendRegister(agentUri: string, metadata: MetadataEntry[]): Promise<Hex>;
  /** pending | reverted | success with the id of the new identity (from Transfer with from = 0). */
  registerResult(tx: Hex): Promise<{ state: "pending" | "reverted" | "missing" } | { state: "success"; erc8004Id: number; owner: Hex }>;
  ownerOf(erc8004Id: number): Promise<Hex | null>;
  sendTransfer(to: Hex, erc8004Id: number): Promise<Hex>;
  txState(tx: Hex): Promise<"pending" | "reverted" | "success" | "missing">;
}

export interface HubIdentityClient {
  getIdentity(agentId: number): Promise<{ chainId: number; registry: Hex; erc8004Id: number }>;
  sendSetIdentity(agentId: number, chainId: number, registry: Hex, erc8004Id: number): Promise<Hex>;
  txState(tx: Hex): Promise<"pending" | "reverted" | "success" | "missing">;
}

export const textBytes = (s: string): Hex => toHex(s);

async function receiptState(pub: PublicClient, hash: Hex) {
  try {
    const r = await pub.getTransactionReceipt({ hash });
    return { state: r.status === "success" ? ("success" as const) : ("reverted" as const), receipt: r };
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name !== "TransactionReceiptNotFoundError") throw e;
    // no receipt: the tx is still in the mempool or was dropped
    try {
      await pub.getTransaction({ hash });
      return { state: "pending" as const };
    } catch {
      return { state: "missing" as const };
    }
  }
}

export class ViemIdentityRegistry implements IdentityRegistryClient {
  readonly chainId: number;
  readonly registry: Hex;
  readonly signer: Hex;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly account: PrivateKeyAccount;
  private readonly chain;

  constructor(ecfg: Erc8004Config, signerPrivateKey: Hex) {
    this.chainId = ecfg.chainId;
    this.registry = ecfg.registry;
    const urls = ecfg.rpcUrls && ecfg.rpcUrls.length > 0 ? ecfg.rpcUrls : [ecfg.rpcUrl];
    this.chain = defineChain({
      id: ecfg.chainId,
      name: ecfg.chainName ?? `chain ${ecfg.chainId}`,
      nativeCurrency: { name: "Ether", symbol: ecfg.nativeSymbol ?? "ETH", decimals: 18 },
      rpcUrls: { default: { http: [urls[0]!] } },
      contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
      fees: { baseFeeMultiplier: 2, maxPriorityFeePerGas: 0n },
    });
    this.account = privateKeyToAccount(signerPrivateKey);
    this.signer = this.account.address;
    this.pub = createPublicClient({ chain: this.chain, transport: rpcTransport(urls, 20_000) }) as PublicClient;
    this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport: rpcTransport(urls, 30_000, 3) });
  }

  private registerData(uri = "https://example.invalid/probe.json", metadata: MetadataEntry[] = []) {
    return encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [uri, metadata] });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.pub.call({ account: this.signer, to: this.registry, data: this.registerData() });
      return true;
    } catch {
      return false;
    }
  }

  async hasGas(): Promise<boolean> {
    const [bal, price] = await Promise.all([this.pub.getBalance({ address: this.signer }), this.pub.getGasPrice()]);
    let gas = 300_000n;
    try {
      gas = await this.pub.estimateGas({ account: this.signer, to: this.registry, data: this.registerData() });
    } catch {
      /* estimate unavailable: use a safe default */
    }
    return bal >= gas * price * 2n;
  }

  sendRegister(agentUri: string, metadata: MetadataEntry[]): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.registry,
      abi: identityRegistryAbi,
      functionName: "register",
      args: [agentUri, metadata],
      account: this.account,
      chain: this.chain,
    });
  }

  async registerResult(tx: Hex) {
    const r = await receiptState(this.pub, tx);
    if (r.state !== "success") return { state: r.state };
    for (const log of r.receipt!.logs) {
      if (log.address.toLowerCase() !== this.registry.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: identityRegistryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Transfer" && /^0x0{40}$/i.test(ev.args.from))
          return { state: "success" as const, erc8004Id: Number(ev.args.tokenId), owner: ev.args.to as Hex };
      } catch {
        /* not our event */
      }
    }
    throw new Error(`register tx ${tx} succeeded but no mint Transfer event was found`);
  }

  async ownerOf(erc8004Id: number): Promise<Hex | null> {
    try {
      return (await this.pub.readContract({ address: this.registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [BigInt(erc8004Id)] })) as Hex;
    } catch {
      return null;
    }
  }

  sendTransfer(to: Hex, erc8004Id: number): Promise<Hex> {
    // transferFrom (not safeTransferFrom): the owner may be a smart wallet without onERC721Received
    return this.wallet.writeContract({
      address: this.registry,
      abi: identityRegistryAbi,
      functionName: "transferFrom",
      args: [this.signer, to, BigInt(erc8004Id)],
      account: this.account,
      chain: this.chain,
    });
  }

  async txState(tx: Hex) {
    return (await receiptState(this.pub, tx)).state;
  }
}

export interface HubIdentityOptions {
  /** RPC URLs in priority order (default: the public Robinhood Chain RPC). */
  rpcUrls?: readonly string[];
  /** Default: the mainnet AgentHub. */
  hubAddress?: Hex;
  chainId?: number; // default: Robinhood Chain mainnet (4663)
  /** Key that sends setAgentIdentity (the agent owner, or the platform's identity job). */
  signerPrivateKey: Hex;
}

export class ViemHubIdentity implements HubIdentityClient {
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly account: PrivateKeyAccount;
  private readonly chain;
  private readonly hub: Hex;

  constructor(o: HubIdentityOptions) {
    this.hub = o.hubAddress ?? AGENT_HUB_ADDRESS;
    this.chain = robinhoodChain({ rpcUrls: o.rpcUrls, chainId: o.chainId ?? ROBINHOOD_CHAIN_ID });
    this.account = privateKeyToAccount(o.signerPrivateKey);
    const urls = o.rpcUrls ?? [];
    this.pub = createPublicClient({ chain: this.chain, transport: rpcTransport(urls, 15_000) }) as PublicClient;
    this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport: rpcTransport(urls, 30_000, 3) });
  }

  async getIdentity(agentId: number) {
    const [chainId, registry, erc8004Id] = await this.pub.readContract({
      address: this.hub,
      abi: agentHubAbi,
      functionName: "getIdentity",
      args: [BigInt(agentId)],
    });
    return { chainId: Number(chainId), registry: registry as Hex, erc8004Id: Number(erc8004Id) };
  }

  sendSetIdentity(agentId: number, chainId: number, registry: Hex, erc8004Id: number): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.hub,
      abi: agentHubAbi,
      functionName: "setAgentIdentity",
      args: [BigInt(agentId), BigInt(chainId), registry, BigInt(erc8004Id)],
      account: this.account,
      chain: this.chain,
    });
  }

  async txState(tx: Hex) {
    return (await receiptState(this.pub, tx)).state;
  }
}
