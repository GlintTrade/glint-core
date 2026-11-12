// Networks and public addresses used by Glint.
// The on-chain layer runs on Robinhood Chain (an Arbitrum Orbit L2, gas in ETH). Trading happens on Lighter.
// Sources: docs.robinhood.com/chain (connecting, contracts, protocol contracts) and docs.paxos.com (USDG).

/** Multicall3: the standard address, deployed on both Robinhood Chain networks. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Robinhood Chain testnet (46630). The public RPC is rate limited; use a provider for load. */
export const ROBINHOOD_TESTNET = {
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  rpcFallbacks: [] as readonly string[],
  explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  multicall3: MULTICALL3,
  testnet: true,
} as const;

/**
 * Robinhood Chain mainnet (4663). The public RPC is rate limited and not recommended for production:
 * pass your own provider RPC (e.g. ROBINHOOD_RPC_URL). eth_getLogs on the public RPC returns at most 10 000 logs per call.
 */
export const ROBINHOOD_MAINNET = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  rpcFallbacks: ["https://robinhood.drpc.org"] as readonly string[],
  explorerUrl: "https://robinhoodchain.blockscout.com",
  multicall3: MULTICALL3,
  testnet: false,
} as const;

export type ChainKey = "testnet" | "mainnet";

export const CHAINS = { testnet: ROBINHOOD_TESTNET, mainnet: ROBINHOOD_MAINNET } as const;

/** Native ETH is address(0) in the contract (e.g. as a marketplace pay token). */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

export interface Deployment {
  hub: `0x${string}`; // AgentHub (proxy address, stable)
  deployBlock?: number; // block of the hub deployment (start of log scans)
  /** Default stablecoin for payments. The field name is historical (`usdc`); on Robinhood Chain it is USDG, same as `usdg`. */
  usdc: `0x${string}`;
  /** USDG (Global Dollar, Paxos), 6 decimals: the canonical stablecoin of Robinhood Chain. */
  usdg: `0x${string}`;
  /** WETH of the canonical bridge (L2 Weth Gateway). */
  weth: `0x${string}`;
}

/** Public deployments. The testnet hub is not deployed (address zero). */
export const DEPLOYMENTS: Record<ChainKey, Deployment> = {
  testnet: {
    hub: "0x0000000000000000000000000000000000000000",
    usdc: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
    usdg: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
    weth: "0x7943e237c7F95DA44E0301572D358911207852Fa",
  },
  mainnet: {
    hub: "0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c",
    deployBlock: 111859549,
    usdc: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  },
};

/** ERC-8004 Identity Registry (canonical deployments of the ERC-8004 reference contracts), on the same chain as AgentHub. */
export const ERC8004 = {
  robinhoodMainnet: {
    chainId: 4663,
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    explorerUrl: "https://robinhoodchain.blockscout.com",
  },
  robinhoodTestnet: {
    chainId: 46630,
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  },
} as const;

/** Default ERC-8004 registry per network (the same chain as AgentHub). */
export const ERC8004_DEFAULT = { mainnet: ERC8004.robinhoodMainnet, testnet: ERC8004.robinhoodTestnet } as const;
