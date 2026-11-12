// Lighter on Robinhood Chain: ExchangeClient implementation (REST + WASM agent signer).
// Endpoints (docs.lighter.xyz/api): orderBookDetails, orderBookOrders, candles, accountsByL1Address, account,
// apikeys, nextNonce, accountLimits, accountOrders, trades, sendTx.

import { toScaledInt } from "../format.js";
import type {
  AgentKeyRef,
  ApiKeyInfo,
  Candle,
  CandleInterval,
  ExchangeAccount,
  ExchangeClient,
  ExchangeFill,
  ExchangeSpotMarket,
  Hex,
  OrderBook,
  OrderRequest,
  OrderResult,
  SpotBalance,
} from "../types.js";
import { AGENT_TX_TYPES, AgentSigner, type SignedTx } from "./agent-signer.js";
import { LighterApiError, type LighterHttp } from "./http.js";
import { KeyedMutex, newClientOrderIndex, nonceKey } from "./nonce.js";
import type { AgentWasm } from "./wasm.js";

export const QUOTE_ASSET = "USDG";

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** orderBookDetails.spot_order_book_details → ExchangeSpotMarket. */
export function parseSpotMarket(d: any): ExchangeSpotMarket | null {
  if (!d || typeof d.symbol !== "string" || !Number.isInteger(d.market_id)) return null;
  const [base, quote] = d.symbol.split("/");
  if (!base || !quote) return null;
  return {
    marketId: d.market_id,
    pair: d.symbol,
    base,
    quote,
    szDecimals: num(d.size_decimals ?? d.supported_size_decimals),
    priceDecimals: num(d.price_decimals ?? d.supported_price_decimals),
    minBaseAmount: num(d.min_base_amount),
    minQuoteAmount: num(d.min_quote_amount),
    status: String(d.status ?? "inactive"),
    isFrozen: d.is_frozen === true,
    startTimestamp: num(d.start_timestamp),
    endTimestamp: num(d.end_timestamp),
    lastPrice: num(d.last_trade_price),
    dayQuoteVolume: num(d.daily_quote_token_volume),
    dayPriceChangePct: num(d.daily_price_change),
  };
}

/**
 * account.assets → spot balances. In a unified trading account (account_trading_mode 1) the collateral asset sits in
 * margin_balance when margin_mode = "enabled" (seen on RH: USDG balance 0, margin_balance 1824). Spendable =
 * balance − locked_balance + margin_balance (margin-enabled assets), minus the cross initial margin requirement for
 * USDG (0 for spot-only accounts). We never count other assets' collateral value (that would be borrowing).
 */
export function parseBalances(acc: any): SpotBalance[] {
  const out: SpotBalance[] = [];
  const imr = num(acc?.cross_initial_margin_requirement);
  for (const a of Array.isArray(acc?.assets) ? acc.assets : []) {
    if (typeof a?.symbol !== "string") continue;
    const margin = a.margin_mode === "enabled" ? num(a.margin_balance) : 0;
    let total = num(a.balance) + margin;
    const hold = num(a.locked_balance) + (a.symbol === QUOTE_ASSET ? Math.min(imr, margin) : 0);
    if (!(total > 0)) total = 0;
    out.push({ coin: a.symbol, total, hold: Math.min(hold, total), entryNtl: 0 });
  }
  return out;
}

export function parseAccount(acc: any): ExchangeAccount {
  return {
    accountIndex: num(acc.index ?? acc.account_index),
    l1Address: String(acc.l1_address) as Hex,
    balances: parseBalances(acc),
    approvedIntegrators: (Array.isArray(acc.approved_integrators) ? acc.approved_integrators : []).map((x: any) => ({
      accountIndex: num(x.account_index),
      maxSpotTakerFee: num(x.max_spot_taker_fee),
      maxSpotMakerFee: num(x.max_spot_maker_fee),
      approvalExpiry: num(x.approval_expiry),
    })),
  };
}

/** orderBookOrders (individual orders) → aggregated L2 levels. */
export function aggregateBook(r: { asks?: any[]; bids?: any[] }): OrderBook {
  const agg = (orders: any[] = [], desc: boolean) => {
    const m = new Map<number, number>();
    for (const o of orders) {
      const px = num(o.price);
      const sz = num(o.remaining_base_amount);
      if (px > 0 && sz > 0) m.set(px, (m.get(px) ?? 0) + sz);
    }
    return [...m.entries()].map(([px, sz]) => ({ px, sz })).sort((a, b) => (desc ? b.px - a.px : a.px - b.px));
  };
  return { bids: agg(r.bids, true), asks: agg(r.asks, false), time: Date.now() };
}

/** trades → fills from the account's side. Our side's client id is the oid. */
export function parseFills(trades: any[], accountIndex: number, integratorIndex: number | null): ExchangeFill[] {
  const out: ExchangeFill[] = [];
  for (const t of trades) {
    if (t?.market_kind && t.market_kind !== "spot") continue;
    const isBid = num(t.bid_account_id) === accountIndex;
    const isAsk = num(t.ask_account_id) === accountIndex;
    if (!isBid && !isAsk) continue;
    const takerIsAsk = t.is_maker_ask === false;
    const weAreTaker = isAsk ? takerIsAsk : !takerIsAsk;
    const igIndex = num(weAreTaker ? t.integrator_taker_fee_collector_index : t.integrator_maker_fee_collector_index);
    const igFee = num(weAreTaker ? t.integrator_taker_fee : t.integrator_maker_fee);
    out.push({
      coin: String(t.market_symbol ?? ""),
      px: num(t.price),
      sz: num(t.size),
      side: isBid ? "B" : "A",
      time: num(t.timestamp),
      oid: num(isBid ? (t.bid_client_id_str ?? t.bid_client_id) : (t.ask_client_id_str ?? t.ask_client_id)),
      orderIndex: String(isBid ? (t.bid_id_str ?? t.bid_id ?? "") : (t.ask_id_str ?? t.ask_id ?? "")),
      ...(integratorIndex !== null && igIndex === integratorIndex ? { builderFee: igFee } : {}),
      feeRate: num(weAreTaker ? t.taker_fee : t.maker_fee),
    });
  }
  return out;
}

const RESOLUTION: Record<CandleInterval, string> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const INTERVAL_MS: Record<CandleInterval, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

export interface LighterClientOptions {
  http: LighterHttp;
  chainId: number;
  isTestnet: boolean;
  /** Loads the agent capability of the WASM signer (lazily, on the first order). */
  agentWasm: () => Promise<AgentWasm>;
  integratorAccountIndex: number | null;
  /** How long to wait for an IOC result (ms). */
  confirmTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number; // ms
}

export class LighterClient implements ExchangeClient {
  readonly isTestnet: boolean;
  readonly chainId: number;
  private readonly http: LighterHttp;
  private readonly locks = new KeyedMutex();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private marketsCache?: { at: number; rows: ExchangeSpotMarket[] };
  private readonly accountIdx = new Map<string, { at: number; idx: number | null }>();

  constructor(private readonly o: LighterClientOptions) {
    this.http = o.http;
    this.chainId = o.chainId;
    this.isTestnet = o.isTestnet;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  // ---------- market data ----------

  async spotMarkets(): Promise<ExchangeSpotMarket[]> {
    if (this.marketsCache && this.now() - this.marketsCache.at < 5_000) return this.marketsCache.rows;
    const r = await this.http.get("/api/v1/orderBookDetails", { filter: "spot" }, "platform");
    const rows = (Array.isArray(r.spot_order_book_details) ? r.spot_order_book_details : [])
      .map(parseSpotMarket)
      .filter((m: ExchangeSpotMarket | null): m is ExchangeSpotMarket => !!m);
    this.marketsCache = { at: this.now(), rows };
    return rows;
  }

  private async marketByPair(coin: string): Promise<ExchangeSpotMarket | undefined> {
    return (await this.spotMarkets()).find((m) => m.pair === coin);
  }

  /** Last trade prices by pair (one request for all markets; held positions are re-priced from the book by the runner). */
  async allMids(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const m of await this.spotMarkets()) if (m.lastPrice > 0) out[m.pair] = m.lastPrice;
    return out;
  }

  async candles(coin: string, interval: CandleInterval, startTimeMs: number): Promise<Candle[]> {
    const m = await this.marketByPair(coin);
    if (!m) return [];
    const end = this.now();
    const count = Math.min(500, Math.max(1, Math.ceil((end - startTimeMs) / INTERVAL_MS[interval]) + 1));
    const r = await this.http.get(
      "/api/v1/candles",
      { market_id: m.marketId, resolution: RESOLUTION[interval], start_timestamp: Math.floor(startTimeMs), end_timestamp: end, count_back: count },
      "platform",
    );
    // ascending by open time; the API may return more history than asked (observed on RH): keep the requested window
    return (Array.isArray(r.c) ? r.c : [])
      .map((c: any) => ({ t: num(c.t), o: num(c.o), h: num(c.h), l: num(c.l), c: num(c.c), v: num(c.v) }))
      .filter((c: Candle) => c.t >= startTimeMs - INTERVAL_MS[interval])
      .sort((a: Candle, b: Candle) => a.t - b.t);
  }

  async l2Book(coin: string): Promise<OrderBook> {
    const m = await this.marketByPair(coin);
    if (!m) return { bids: [], asks: [] };
    const r = await this.http.get("/api/v1/orderBookOrders", { market_id: m.marketId, limit: 100 }, "platform");
    return aggregateBook(r);
  }

  // ---------- accounts ----------

  async accountIndexOf(l1: Hex): Promise<number | null> {
    const key = l1.toLowerCase();
    const hit = this.accountIdx.get(key);
    if (hit && this.now() - hit.at < (hit.idx === null ? 30_000 : 10 * 60_000)) return hit.idx;
    let idx: number | null = null;
    try {
      const r = await this.http.get("/api/v1/accountsByL1Address", { l1_address: l1 }, "platform");
      const master = (Array.isArray(r.sub_accounts) ? r.sub_accounts : []).find((a: any) => num(a.account_type) === 0);
      idx = master ? num(master.index) : null;
    } catch (e) {
      if (!(e instanceof LighterApiError && e.code === 21100)) throw e; // 21100: account not found (no deposit yet)
    }
    this.accountIdx.set(key, { at: this.now(), idx });
    return idx;
  }

  async account(accountIndex: number): Promise<ExchangeAccount | null> {
    try {
      const r = await this.http.get("/api/v1/account", { by: "index", value: accountIndex }, "platform");
      const acc = Array.isArray(r.accounts) ? r.accounts[0] : null;
      return acc ? parseAccount(acc) : null;
    } catch (e) {
      if (e instanceof LighterApiError && e.code === 21100) return null;
      throw e;
    }
  }

  async spotBalances(l1: Hex): Promise<SpotBalance[]> {
    const idx = await this.accountIndexOf(l1);
    if (idx === null) return [];
    return (await this.account(idx))?.balances ?? [];
  }

  async apiKeys(accountIndex: number): Promise<ApiKeyInfo[]> {
    const r = await this.http.get("/api/v1/apikeys", { account_index: accountIndex, api_key_index: 255 }, "platform");
    return (Array.isArray(r.api_keys) ? r.api_keys : []).map((k: any) => ({
      apiKeyIndex: num(k.api_key_index),
      publicKey: String(k.public_key ?? "")
        .replace(/^0x/, "")
        .toLowerCase(),
      nonce: num(k.nonce),
    }));
  }

  async nextNonce(accountIndex: number, apiKeyIndex: number): Promise<number> {
    const r = await this.http.get("/api/v1/nextNonce", { account_index: accountIndex, api_key_index: apiKeyIndex }, "platform");
    const n = num(r.nonce);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("nextNonce: bad response");
    return n;
  }

  private async signer(key: AgentKeyRef): Promise<AgentSigner> {
    return new AgentSigner(await this.o.agentWasm(), { ...key, chainId: this.chainId });
  }

  async accountTier(key: AgentKeyRef): Promise<string | null> {
    try {
      const auth = (await this.signer(key)).authToken();
      const r = await this.http.get("/api/v1/accountLimits", { account_index: key.accountIndex }, auth);
      return typeof r.user_tier === "string" ? r.user_tier.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  async fillsSince(key: AgentKeyRef, startTimeMs: number): Promise<ExchangeFill[]> {
    const auth = (await this.signer(key)).authToken();
    const out: ExchangeFill[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await this.http.get("/api/v1/trades", { account_index: key.accountIndex, market_type: "spot", sort_by: "timestamp", limit: 100, cursor }, auth);
      const trades: any[] = Array.isArray(r.trades) ? r.trades : [];
      const fills = parseFills(trades, key.accountIndex, this.o.integratorAccountIndex);
      out.push(...fills.filter((f) => f.time >= startTimeMs));
      const oldest = trades.reduce((m, t) => Math.min(m, num(t.timestamp)), Infinity);
      if (!r.next_cursor || trades.length < 100 || oldest < startTimeMs) break;
      cursor = r.next_cursor;
    }
    return out;
  }

  // ---------- orders ----------

  /** sendTx for agent transactions only: create order / cancel / cancel all. */
  private async sendAgentTx(tx: SignedTx): Promise<{ txHash: string }> {
    if (!AGENT_TX_TYPES.has(tx.txType)) throw new Error(`refusing to send tx type ${tx.txType} with an agent key`);
    const r = await this.http.postForm("/api/v1/sendTx", { tx_type: String(tx.txType), tx_info: tx.txInfo });
    return { txHash: String(r.tx_hash ?? tx.txHash) };
  }

  async placeOrder(key: AgentKeyRef, order: OrderRequest): Promise<OrderResult> {
    if (order.tif !== "Ioc") return { status: "error", error: "only IOC orders are supported" };
    let baseAmount: number, price: number;
    try {
      baseAmount = toScaledInt(order.size, order.szDecimals);
      price = toScaledInt(order.price, order.priceDecimals);
    } catch (e) {
      return { status: "error", error: (e as Error).message };
    }
    const clientOrderIndex = newClientOrderIndex(this.now());
    const signer = await this.signer(key);
    return this.locks.run(nonceKey(key.accountIndex, key.apiKeyIndex), async () => {
      let sent: { txHash: string } | null = null;
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        try {
          const nonce = await this.nextNonce(key.accountIndex, key.apiKeyIndex);
          const tx = signer.signCreateOrder(
            {
              marketIndex: order.marketId,
              clientOrderIndex,
              baseAmount,
              price,
              isAsk: !order.isBuy,
              orderType: "limit",
              timeInForce: "ioc",
              integrator: order.integrator,
            },
            nonce,
          );
          sent = await this.sendAgentTx(tx);
        } catch (e) {
          // 21104 invalid nonce: the previous tx on this key is still being applied; the nonce was not consumed
          if (e instanceof LighterApiError && e.code === 21104 && attempt < 2) {
            await this.sleep(400);
            continue;
          }
          return { status: "error", oid: clientOrderIndex, error: (e as Error).message };
        }
      }
      if (!sent) return { status: "error", oid: clientOrderIndex, error: "not sent" };
      return this.confirm(signer, key, order, clientOrderIndex, sent.txHash);
    });
  }

  /** Waits for the IOC result: accountOrders by client_order_index → filled_base_amount / filled_quote_amount. */
  private async confirm(signer: AgentSigner, key: AgentKeyRef, order: OrderRequest, clientOrderIndex: number, txHash: string): Promise<OrderResult> {
    const deadline = this.now() + (this.o.confirmTimeoutMs ?? 8_000);
    const auth = signer.authToken();
    let wait = 300;
    while (this.now() <= deadline) {
      await this.sleep(wait);
      wait = Math.min(1500, wait * 2);
      let o: any;
      try {
        const r = await this.http.get("/api/v1/accountOrders", { account_index: key.accountIndex, client_order_indexes: String(clientOrderIndex) }, auth);
        o = (Array.isArray(r.orders) ? r.orders : []).find((x: any) => num(x.client_order_index) === clientOrderIndex);
      } catch {
        continue;
      }
      if (!o) continue;
      const status = String(o.status ?? "");
      if (status === "in-progress" || status === "pending" || status === "open") {
        if (status === "open") return { status: "resting", oid: clientOrderIndex, orderIndex: String(o.order_id ?? o.order_index ?? ""), txHash };
        continue;
      }
      const filled = num(o.filled_base_amount);
      const quote = num(o.filled_quote_amount);
      const res: OrderResult = {
        status: filled > 0 ? "filled" : "error",
        oid: clientOrderIndex,
        orderIndex: String(o.order_id ?? o.order_index ?? ""),
        txHash,
      };
      if (filled > 0) {
        res.filledSz = filled;
        res.avgPx = quote > 0 ? quote / filled : Number(order.price);
        res.integratorFeeRate = num(o.integrator_taker_fee);
        res.netBaseReceived = await this.netBase(auth, key.accountIndex, res, order);
      } else res.error = status || "not filled";
      return res;
    }
    return { status: "unknown", oid: clientOrderIndex, txHash, error: "order result not confirmed in time" };
  }

  /**
   * Buys: fees are charged in the received asset (the base token) — exchange taker fee + integrator fee.
   * Read the actual fee rates from the fills of this order; fall back to the integrator rate of the order.
   */
  private async netBase(auth: string, accountIndex: number, res: OrderResult, order: OrderRequest): Promise<number | undefined> {
    if (!order.isBuy || !res.filledSz) return undefined;
    let rate = (res.integratorFeeRate ?? 0) / 1e6;
    try {
      const r = await this.http.get("/api/v1/trades", { account_index: accountIndex, order_index_str: res.orderIndex, sort_by: "timestamp", limit: 100 }, auth);
      const fills = parseFills(Array.isArray(r.trades) ? r.trades : [], accountIndex, this.o.integratorAccountIndex);
      const sz = fills.reduce((s, f) => s + f.sz, 0);
      if (sz > 0) rate = fills.reduce((s, f) => s + f.sz * ((f.feeRate ?? 0) + (f.builderFee ?? 0)), 0) / sz / 1e6;
    } catch {
      /* rate of the order */
    }
    return res.filledSz * (1 - Math.max(0, Math.min(rate, 0.05)));
  }
}
