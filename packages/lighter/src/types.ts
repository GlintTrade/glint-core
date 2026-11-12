// Exchange interface used by the runner, the watchdog and the agent pages. Implementation: Lighter on Robinhood Chain
// (lighter/client.ts); tests substitute a fake. Spot only.
//
// Identifiers (all documented here once):
//  • coin     — the Lighter spot pair symbol, e.g. "NVDA/USDG". Market data is keyed by it.
//  • symbol   — the base asset, e.g. "NVDA" (spec.markets, balances, trades).
//  • l1       — the user's EVM address. It owns the Lighter account; AgentHub stores it in the `hlAccount` field
//               (a field name kept for ABI compatibility).
//  • accountIndex — Lighter's integer account id (master account of the l1, resolved via accountsByL1Address).
//  • apiKeyIndex  — the slot (4–156, 158–254 on RH) of the agent's API key on that account.
//  • oid      — OUR client_order_index (uint48, unique per account, assigned by the runner). It is what AgentHub
//               receipts carry as `hlOrderId`; the exchange order_index (int64, above 2^53) is kept off-chain.

export type Hex = `0x${string}`;

export type CandleInterval = "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface BookLevel {
  px: number;
  sz: number;
}

/** bids by descending price, asks by ascending price (aggregated Lighter orderBookOrders). */
export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  time?: number;
}

/** Spot balance by asset symbol (USDG, NVDA, ...). total/hold in wire units of the asset. */
export interface SpotBalance {
  coin: string;
  total: number;
  hold: number;
  /** Entry notional by exchange data (Lighter does not report it for spot: 0). */
  entryNtl: number;
}

/** Lighter market status (orderBookDetails.status). Only "active" is tradeable. */
export type ExchangeMarketStatus = "active" | "inactive" | "in-settlement" | "waiting-for-settlement" | "settled" | string;

export interface ExchangeSpotMarket {
  marketId: number;
  pair: string; // "NVDA/USDG"
  base: string; // "NVDA"
  quote: string; // "USDG"
  szDecimals: number;
  priceDecimals: number;
  minBaseAmount: number;
  minQuoteAmount: number;
  status: ExchangeMarketStatus;
  isFrozen: boolean;
  startTimestamp: number; // ms, 0 = none
  endTimestamp: number; // ms, 0 = none
  lastPrice: number;
  dayQuoteVolume: number; // 24h volume in USDG
  dayPriceChangePct: number;
}

export interface ApprovedIntegrator {
  accountIndex: number;
  maxSpotTakerFee: number; // millionths: 100 = 1 bp
  maxSpotMakerFee: number;
  approvalExpiry: number; // unix ms
}

export interface ExchangeAccount {
  accountIndex: number;
  l1Address: Hex;
  balances: SpotBalance[];
  approvedIntegrators: ApprovedIntegrator[];
}

export interface ApiKeyInfo {
  apiKeyIndex: number;
  publicKey: string; // hex, lower case, no 0x
  nonce: number;
}

/** A fill of the account (trades endpoint), from the account's side. */
export interface ExchangeFill {
  coin: string; // pair, "NVDA/USDG"
  px: number;
  sz: number;
  side: "B" | "A";
  time: number; // ms
  /** Our client_order_index of the account's order in this fill (0 for orders placed outside Glint). */
  oid: number;
  orderIndex?: string;
  /** Integrator (platform) fee rate in millionths, if the fill was attributed to OUR integrator account. */
  builderFee?: number;
  /** Exchange fee rate of the account's side, millionths. */
  feeRate?: number;
}

/** The agent's key: decrypted only for the duration of a call; never logged. */
export interface AgentKeyRef {
  accountIndex: number;
  apiKeyIndex: number;
  privateKey: string;
}

export interface OrderRequest {
  marketId: number;
  coin: string;
  isBuy: boolean;
  price: string; // decimal string, ≤ priceDecimals decimals (worst acceptable price)
  size: string; // decimal string, ≤ szDecimals decimals
  szDecimals: number;
  priceDecimals: number;
  tif: "Ioc";
  /** Partner attribution. Only set when the user approved the platform's integrator account. */
  integrator?: { accountIndex: number; takerFee: number; makerFee: number };
}

export interface OrderResult {
  status: "filled" | "resting" | "error" | "unknown";
  /** Our client_order_index. */
  oid?: number;
  orderIndex?: string;
  txHash?: string;
  filledSz?: number;
  avgPx?: number;
  /** Size actually credited for a buy after exchange + integrator fees (charged in the received asset). */
  netBaseReceived?: number;
  integratorFeeRate?: number;
  error?: string;
}

export interface ExchangeClient {
  readonly isTestnet: boolean;
  readonly chainId: number;
  spotMarkets(): Promise<ExchangeSpotMarket[]>;
  /** Mid (or last) prices by pair ("NVDA/USDG"). */
  allMids(): Promise<Record<string, number>>;
  candles(coin: string, interval: CandleInterval, startTimeMs: number): Promise<Candle[]>;
  /** L2 book by pair: bids descending, asks ascending. Empty if the market is unknown. */
  l2Book(coin: string): Promise<OrderBook>;
  /** Master account index of an L1 address; null if the address has no Lighter account yet (no deposit). */
  accountIndexOf(l1: Hex): Promise<number | null>;
  account(accountIndex: number): Promise<ExchangeAccount | null>;
  /** Spot balances of the l1's master account ([] if there is no account). */
  spotBalances(l1: Hex): Promise<SpotBalance[]>;
  apiKeys(accountIndex: number): Promise<ApiKeyInfo[]>;
  nextNonce(accountIndex: number, apiKeyIndex: number): Promise<number>;
  /** Account tier ("standard" | "plus" | "premium" ...) read with an auth token of the agent key; null if unknown. */
  accountTier(key: AgentKeyRef): Promise<string | null>;
  fillsSince(key: AgentKeyRef, startTimeMs: number): Promise<ExchangeFill[]>;
  /** Signs with the agent key (orders only, see lighter/agent-signer.ts) and confirms the IOC result. */
  placeOrder(key: AgentKeyRef, order: OrderRequest): Promise<OrderResult>;
}
