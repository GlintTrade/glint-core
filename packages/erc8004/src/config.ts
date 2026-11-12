// ERC-8004 configuration from env (the module is self-contained and disabled by default):
//   ERC8004_ENABLED=false          background registration of agents in the Identity Registry
//   ERC8004_RPC_URL                registry RPC (default: the AgentHub RPCs when the registry lives on the same chain)
//   ERC8004_REGISTRY               Identity Registry address (default: the canonical ERC-8004 deployment on Robinhood Chain)
//   ERC8004_CHAIN_ID               registry chain id (default: 4663 mainnet / 46630 testnet)
//   ERC8004_TRANSFER_TO_OWNER=true transfer the identity NFT to the agent owner after registration
//   ERC8004_POLL_SEC=30, ERC8004_MAX_ATTEMPTS=10
//   ERC8004_EXPLORER_URL           explorer (default: Blockscout of the registry chain)
//   PUBLIC_API_URL                 public API base URL (the agentURI is built from it)
import { ERC8004_DEFAULT } from "@glint/strategy";

export type Hex = `0x${string}`;

export interface Erc8004Config {
  enabled: boolean;
  chainId: number;
  registry: Hex;
  /** Primary registry RPC. */
  rpcUrl: string;
  /** Every RPC in priority order (primary first); empty or missing = rpcUrl only. */
  rpcUrls?: string[];
  /** Chain name and native token, for the viem chain and error messages. */
  chainName?: string;
  nativeSymbol?: string;
  publicApiUrl: string;
  webUrl: string;
  transferToOwner: boolean;
  pollSec: number;
  maxAttempts: number;
  explorerUrl?: string;
}

/** The AgentHub chain as the app knows it (to reuse its RPCs when the registry is on the same chain). */
export interface Erc8004HubChain {
  id: number;
  name: string;
  rpcUrl: string;
  rpcFallbacks: readonly string[];
  nativeCurrency: { symbol: string };
}

export interface Erc8004AppSettings {
  network: "mainnet" | "testnet";
  /** Local API port, used for the default PUBLIC_API_URL (http://localhost:<port>). Default 8787. */
  port?: number;
  /** Public website URL (registration file links). */
  webUrl: string;
  /** AgentHub chain and the app's own RPCs for it (provider first). */
  chain?: Erc8004HubChain;
  rpcUrl?: string;
  rpcUrls?: string[];
}

const truthy = (s: string | undefined, def: boolean) =>
  s === undefined || s.trim() === "" ? def : ["1", "true", "yes", "on"].includes(s.trim().toLowerCase());
const numOr = (s: string | undefined, def: number) => {
  const n = Number(s);
  return s !== undefined && s.trim() !== "" && Number.isFinite(n) ? n : def;
};

export function loadErc8004Config(env: Record<string, string | undefined>, app: Erc8004AppSettings): Erc8004Config {
  const base = ERC8004_DEFAULT[app.network];
  const registry = (env.ERC8004_REGISTRY?.trim() || base.identityRegistry) as Hex;
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) throw new Error("ERC8004_REGISTRY must be an address");
  const chainId = numOr(env.ERC8004_CHAIN_ID, base.chainId);
  const chain = app.chain;
  const sameChain = chain !== undefined && chain.id === chainId;
  const hubUrls = sameChain ? [...new Set([...(app.rpcUrls ?? []), app.rpcUrl ?? chain.rpcUrl, chain.rpcUrl, ...chain.rpcFallbacks])] : [];
  const override = env.ERC8004_RPC_URL?.trim();
  const rpcUrls = override ? [override] : hubUrls;
  if (rpcUrls.length === 0 && truthy(env.ERC8004_ENABLED, false)) {
    throw new Error(`ERC8004_RPC_URL is required: the registry chain ${chainId} is not the AgentHub chain`);
  }
  return {
    enabled: truthy(env.ERC8004_ENABLED, false),
    chainId,
    registry,
    rpcUrl: rpcUrls[0] ?? "",
    rpcUrls,
    chainName: sameChain ? chain.name : `chain ${chainId}`,
    nativeSymbol: sameChain ? chain.nativeCurrency.symbol : "ETH",
    publicApiUrl: (env.PUBLIC_API_URL?.trim() || `http://localhost:${app.port ?? 8787}`).replace(/\/+$/, ""),
    webUrl: app.webUrl.replace(/\/+$/, ""),
    transferToOwner: truthy(env.ERC8004_TRANSFER_TO_OWNER, true),
    pollSec: Math.max(5, numOr(env.ERC8004_POLL_SEC, 30)),
    maxAttempts: Math.max(1, numOr(env.ERC8004_MAX_ATTEMPTS, 10)),
    explorerUrl: env.ERC8004_EXPLORER_URL?.trim() || (chainId === base.chainId ? base.explorerUrl : undefined),
  };
}

/** Explorers by registry chain id and the link format of an identity NFT (Blockscout: /token/<registry>/instance/<id>). */
export const ERC8004_EXPLORERS: Record<number, { url: string; nftPath: (registry: string, id: number) => string } | undefined> = {
  4663: { url: "https://robinhoodchain.blockscout.com", nftPath: (r, id) => `/token/${r}/instance/${id}` },
  46630: { url: "https://explorer.testnet.chain.robinhood.com", nftPath: (r, id) => `/token/${r}/instance/${id}` },
};

/** CAIP-10 style registry id: eip155:<chainId>:<registry>. */
export const agentRegistryId = (chainId: number, registry: string) => `eip155:${chainId}:${registry}`;
/** Stable agentURI served by the public API. */
export const agentUriFor = (publicApiUrl: string, agentId: number) => `${publicApiUrl}/v1/agents/${agentId}/erc8004.json`;
