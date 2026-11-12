// Public deployment of AgentHub on Robinhood Chain (Arbitrum Orbit L2, gas in ETH).

export const ROBINHOOD_CHAIN_ID = 4663;

/** AgentHub proxy on Robinhood Chain mainnet. The address never changes. */
export const AGENT_HUB_ADDRESS = "0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c" as const;

/** Block of the deployment: the first block an indexer needs to scan. */
export const AGENT_HUB_DEPLOY_BLOCK = 111859549;

/** Public, rate-limited RPC. For production use a provider RPC of your own. */
export const ROBINHOOD_PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

/** Multicall3 at its standard address (present on Robinhood Chain). */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
