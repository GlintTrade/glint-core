// Lighter RH adapter with mocked HTTP: market data, accounts, balances (unified account), fills, IOC orders,
// nonce serialisation per API key, auth-token allowlist.
import { describe, expect, it } from "vitest";
import { aggregateBook, LighterClient, parseBalances, parseFills } from "../src/lighter/client.js";
import { type FetchLike, LighterHttp } from "../src/lighter/http.js";
import { KeyedMutex, newClientOrderIndex } from "../src/lighter/nonce.js";
import type { AgentWasm } from "../src/lighter/wasm.js";

type Route = (q: URLSearchParams, init: { method?: string; headers?: Record<string, string>; body?: string }) => unknown;

function mockHttp(routes: Record<string, Route>) {
  const log: { path: string; q: URLSearchParams; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const u = new URL(url);
    log.push({ path: u.pathname, q: u.searchParams, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const r = routes[u.pathname];
    if (!r) return { ok: false, status: 404, json: async () => ({ code: 404, message: "no route" }), text: async () => "" };
    const body = await r(u.searchParams, init);
    if (body && typeof body === "object" && "__status" in (body as object)) {
      const b = body as { __status: number };
      return { ok: false, status: b.__status, json: async () => ({ code: b.__status }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { http: new LighterHttp({ baseUrl: "https://api.rh-testnet.lighter.xyz", fetchImpl, readToken: "ro:1:all:9:x", sleep: async () => {} }), log };
}

/** A fake agent WASM capability: signs anything allowed, records nonces. */
function agentWasm(nonces: number[] = []): AgentWasm {
  return Object.freeze({
    CreateClient: () => ({}),
    SignCreateOrder: (...a: unknown[]) => (
      nonces.push(a[16] as number), { txType: 14, txInfo: JSON.stringify({ Nonce: a[16], ClientOrderIndex: a[1] }), txHash: `h${a[16]}` }
    ),
    SignCancelOrder: () => ({ txType: 15, txInfo: "{}", txHash: "c" }),
    SignCancelAllOrders: () => ({ txType: 16, txInfo: "{}", txHash: "ca" }),
    CreateAuthToken: () => ({ authToken: "9:1234:254:aa" }),
  }) as unknown as AgentWasm;
}

const KEY = { accountIndex: 1234, apiKeyIndex: 254, privateKey: `0x${"ab".repeat(40)}` };
const NVDA = {
  symbol: "NVDA/USDG",
  market_id: 2054,
  market_type: "spot",
  status: "active",
  size_decimals: 4,
  price_decimals: 2,
  min_base_amount: "0.0400",
  min_quote_amount: "10.000000",
  last_trade_price: 176,
  daily_quote_token_volume: 225689.48,
  daily_price_change: 2.5,
  is_frozen: false,
  start_timestamp: 0,
  end_timestamp: 0,
};

const client = (http: LighterHttp, extra: Partial<ConstructorParameters<typeof LighterClient>[0]> = {}) =>
  new LighterClient({ http, chainId: 300, isTestnet: true, integratorAccountIndex: 777, agentWasm: async () => agentWasm(), sleep: async () => {}, ...extra });

describe("market data", () => {
  it("orderBookDetails → spot markets (perps ignored), mids by pair, candles and books by market_id", async () => {
    const { http, log } = mockHttp({
      "/api/v1/orderBookDetails": () => ({ code: 200, order_book_details: [{ symbol: "NVDA", market_id: 15 }], spot_order_book_details: [NVDA] }),
      "/api/v1/candles": (q) => ({ code: 200, r: q.get("resolution"), c: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, V: 15, i: 1 }] }),
      "/api/v1/orderBookOrders": () => ({
        code: 200,
        asks: [
          { price: "176.02", remaining_base_amount: "1.0" },
          { price: "175.97", remaining_base_amount: "2.5" },
          { price: "175.97", remaining_base_amount: "0.5" },
        ],
        bids: [
          { price: "175.72", remaining_base_amount: "3" },
          { price: "175.89", remaining_base_amount: "1" },
          { price: "0", remaining_base_amount: "9" },
        ],
      }),
    });
    const c = client(http);
    const ms = await c.spotMarkets();
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({
      marketId: 2054,
      pair: "NVDA/USDG",
      base: "NVDA",
      quote: "USDG",
      szDecimals: 4,
      priceDecimals: 2,
      minBaseAmount: 0.04,
      status: "active",
    });
    expect(await c.allMids()).toEqual({ "NVDA/USDG": 176 });
    const candles = await c.candles("NVDA/USDG", "1h", 1000);
    expect(candles).toEqual([{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
    const cq = log.find((l) => l.path === "/api/v1/candles")!.q;
    expect([cq.get("market_id"), cq.get("resolution"), cq.get("start_timestamp"), cq.get("count_back")]).toEqual(["2054", "1h", "1000", "500"]);
    const book = await c.l2Book("NVDA/USDG");
    expect(book.asks).toEqual([
      { px: 175.97, sz: 3 },
      { px: 176.02, sz: 1 },
    ]);
    expect(book.bids).toEqual([
      { px: 175.89, sz: 1 },
      { px: 175.72, sz: 3 },
    ]);
    expect(await c.l2Book("NOPE/USDG")).toEqual({ bids: [], asks: [] });
    // public reads carry the platform read-only token (L1 rate-limit budget, not the server IP)
    expect(log.every((l) => l.headers.authorization === "ro:1:all:9:x")).toBe(true);
  });

  it("aggregateBook sorts and merges levels", () => {
    expect(
      aggregateBook({
        asks: [
          { price: "2", remaining_base_amount: "1" },
          { price: "1", remaining_base_amount: "1" },
        ],
        bids: [],
      }).asks.map((l) => l.px),
    ).toEqual([1, 2]);
  });
});

describe("accounts and balances", () => {
  it("accountsByL1Address → master account; 21100 (no deposit yet) → null", async () => {
    const { http } = mockHttp({
      "/api/v1/accountsByL1Address": (q) =>
        q.get("l1_address") === "0x00000000000000000000000000000000000000a1"
          ? {
              code: 200,
              sub_accounts: [
                { account_type: 1, index: 281474976710600 },
                { account_type: 0, index: 21897 },
              ],
            }
          : { __status: 400 },
    });
    const c = client(http);
    expect(await c.accountIndexOf("0x00000000000000000000000000000000000000a1")).toBe(21897);
  });

  it("unknown address: Lighter answers 21100 → null (and the miss is cached briefly)", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => (
      calls++, { ok: false, status: 400, json: async () => ({ code: 21100, message: "account not found" }), text: async () => "" }
    );
    const c = client(new LighterHttp({ baseUrl: "https://x.test", fetchImpl, sleep: async () => {} }));
    expect(await c.accountIndexOf("0x00000000000000000000000000000000000000b2")).toBeNull();
    expect(await c.accountIndexOf("0x00000000000000000000000000000000000000b2")).toBeNull();
    expect(calls).toBe(1);
  });

  it("unified account: USDG sits in margin_balance when margin_mode is enabled; locked balance is held", () => {
    const b = parseBalances({
      cross_initial_margin_requirement: "0.000000",
      assets: [
        { symbol: "USDG", balance: "0.000000", locked_balance: "0.000000", margin_mode: "enabled", margin_balance: "1824.300878" },
        { symbol: "NVDA", balance: "3.694100", locked_balance: "0.5", margin_mode: "disabled", margin_balance: "0.000000" },
      ],
    });
    expect(b).toEqual([
      { coin: "USDG", total: 1824.300878, hold: 0, entryNtl: 0 },
      { coin: "NVDA", total: 3.6941, hold: 0.5, entryNtl: 0 },
    ]);
    // a perp margin requirement is held from USDG (never spend collateral that backs a position)
    expect(
      parseBalances({
        cross_initial_margin_requirement: "100",
        assets: [{ symbol: "USDG", balance: "0", locked_balance: "0", margin_mode: "enabled", margin_balance: "500" }],
      })[0].hold,
    ).toBe(100);
  });

  it("account: balances + approved integrators; apikeys without 0x; nextNonce", async () => {
    const { http } = mockHttp({
      "/api/v1/account": () => ({
        code: 200,
        accounts: [
          {
            index: 21897,
            l1_address: "0x49a6F989974CB9C54ad8f48c2FD96C8b381361cF",
            assets: [],
            approved_integrators: [{ account_index: 777, max_spot_taker_fee: 1000, max_spot_maker_fee: 500, approval_expiry: 1819956047045 }],
          },
        ],
      }),
      "/api/v1/apikeys": (q) => (expect(q.get("api_key_index")).toBe("255"), { code: 200, api_keys: [{ api_key_index: 0, public_key: "FB2A", nonce: 5 }] }),
      "/api/v1/nextNonce": () => ({ code: 200, nonce: 12 }),
    });
    const c = client(http);
    expect((await c.account(21897))!.approvedIntegrators).toEqual([
      { accountIndex: 777, maxSpotTakerFee: 1000, maxSpotMakerFee: 500, approvalExpiry: 1819956047045 },
    ]);
    expect(await c.apiKeys(21897)).toEqual([{ apiKeyIndex: 0, publicKey: "fb2a", nonce: 5 }]);
    expect(await c.nextNonce(21897, 254)).toBe(12);
  });

  it("fills: account side, our client id as oid, integrator attribution only for OUR integrator", () => {
    const t = (o: object) => ({ market_kind: "spot", market_symbol: "NVDA/USDG", price: "176.00", size: "2", timestamp: 5, is_maker_ask: true, ...o });
    const fills = parseFills(
      [
        t({
          bid_account_id: 1234,
          ask_account_id: 9,
          bid_client_id_str: "179000000000001",
          bid_id_str: "578712552113133972",
          taker_fee: 0,
          integrator_taker_fee: 100,
          integrator_taker_fee_collector_index: 777,
        }),
        t({
          ask_account_id: 1234,
          bid_account_id: 9,
          is_maker_ask: false,
          ask_client_id_str: "5",
          integrator_taker_fee: 300,
          integrator_taker_fee_collector_index: 18971,
        }),
        t({ bid_account_id: 1, ask_account_id: 2 }),
        { ...t({ bid_account_id: 1234 }), market_kind: "perps" },
      ],
      1234,
      777,
    );
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ coin: "NVDA/USDG", side: "B", oid: 179000000000001, orderIndex: "578712552113133972", builderFee: 100, px: 176, sz: 2 });
    expect(fills[1]).toMatchObject({ side: "A", oid: 5 });
    expect(fills[1].builderFee).toBeUndefined(); // another partner's attribution is not ours
  });
});

describe("IOC orders", () => {
  function orderRoutes(over: Partial<Record<string, Route>> = {}) {
    let nonce = 7;
    const sent: Record<string, string>[] = [];
    const routes: Record<string, Route> = {
      "/api/v1/nextNonce": () => ({ code: 200, nonce }),
      "/api/v1/sendTx": (_q, init) => {
        const f = Object.fromEntries(new URLSearchParams(init.body));
        sent.push(f);
        nonce++;
        return { code: 200, tx_hash: `tx${sent.length}` };
      },
      "/api/v1/accountOrders": (q) => ({
        code: 200,
        orders: [
          {
            client_order_index: Number(q.get("client_order_indexes")),
            order_id: "578712552113133972",
            status: "filled",
            filled_base_amount: "0.0400",
            filled_quote_amount: "7.042000",
            integrator_taker_fee: "100",
          },
        ],
      }),
      "/api/v1/trades": () => ({
        code: 200,
        trades: [
          {
            market_kind: "spot",
            bid_account_id: 1234,
            ask_account_id: 9,
            size: "0.04",
            price: "176.05",
            is_maker_ask: true,
            taker_fee: 150,
            integrator_taker_fee: 100,
            integrator_taker_fee_collector_index: 777,
          },
        ],
      }),
      ...over,
    };
    return { routes, sent };
  }

  it("signs with the agent key, sends tx_type 14, confirms the fill; buy: net size after fees in the bought token", async () => {
    const { routes, sent } = orderRoutes();
    const { http, log } = mockHttp(routes);
    const nonces: number[] = [];
    const c = client(http, { agentWasm: async () => agentWasm(nonces) });
    const r = await c.placeOrder(KEY, {
      marketId: 2054,
      coin: "NVDA/USDG",
      isBuy: true,
      price: "177.80",
      size: "0.04",
      szDecimals: 4,
      priceDecimals: 2,
      tif: "Ioc",
      integrator: { accountIndex: 777, takerFee: 100, makerFee: 0 },
    });
    expect(r).toMatchObject({ status: "filled", filledSz: 0.04, orderIndex: "578712552113133972", txHash: "tx1" });
    expect(r.avgPx).toBeCloseTo(176.05, 9);
    // exchange taker fee 150 + integrator 100 millionths, charged in NVDA
    expect(r.netBaseReceived).toBeCloseTo(0.04 * (1 - 250 / 1e6), 12);
    expect(nonces).toEqual([7]);
    expect(sent[0].tx_type).toBe("14");
    // the auth token goes only to authenticated GET reads, never to sendTx
    expect(log.find((l) => l.path === "/api/v1/sendTx")!.headers.authorization).toBeUndefined();
    expect(log.find((l) => l.path === "/api/v1/accountOrders")!.headers.authorization).toBe("9:1234:254:aa");
    // the client order index fits uint48 and a JS safe integer
    expect(r.oid!).toBeLessThan(2 ** 48);
  });

  it("IOC not filled → error; sizes/prices with too many decimals are refused before signing", async () => {
    const { routes } = orderRoutes({
      "/api/v1/accountOrders": (q) => ({
        code: 200,
        orders: [
          {
            client_order_index: Number(q.get("client_order_indexes")),
            status: "canceled-too-much-slippage",
            filled_base_amount: "0",
            filled_quote_amount: "0",
          },
        ],
      }),
    });
    const c = client(mockHttp(routes).http);
    const r = await c.placeOrder(KEY, {
      marketId: 2054,
      coin: "NVDA/USDG",
      isBuy: false,
      price: "175.00",
      size: "0.04",
      szDecimals: 4,
      priceDecimals: 2,
      tif: "Ioc",
    });
    expect(r).toMatchObject({ status: "error", error: "canceled-too-much-slippage" });
    const bad = await c.placeOrder(KEY, {
      marketId: 2054,
      coin: "NVDA/USDG",
      isBuy: false,
      price: "175.001",
      size: "0.04",
      szDecimals: 4,
      priceDecimals: 2,
      tif: "Ioc",
    });
    expect(bad.status).toBe("error");
  });

  it("21104 invalid nonce (previous tx still applying, nonce not consumed) → re-read nonce and resend", async () => {
    const { routes, sent } = orderRoutes();
    const send = routes["/api/v1/sendTx"];
    const c = client(
      mockHttp({
        ...routes,
        "/api/v1/sendTx": (() => {
          let n = 0;
          return (q: URLSearchParams, init: { body?: string }) => (++n === 1 ? { code: 21104, message: "invalid nonce" } : send(q, init));
        })(),
      }).http,
    );
    const r = await c.placeOrder(KEY, {
      marketId: 2054,
      coin: "NVDA/USDG",
      isBuy: true,
      price: "177.80",
      size: "0.04",
      szDecimals: 4,
      priceDecimals: 2,
      tif: "Ioc",
    });
    expect(r.status).toBe("filled");
    expect(sent).toHaveLength(1);
  });

  it("nonces are serialised per API key: concurrent orders on one key run one after another; other keys in parallel", async () => {
    const order: string[] = [];
    let nonce = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { http } = mockHttp({
      "/api/v1/nextNonce": (q) => (order.push(`nonce:${q.get("api_key_index")}:${nonce}`), { code: 200, nonce }),
      "/api/v1/sendTx": async () => {
        nonce++;
        return { code: 200, tx_hash: "t" };
      },
      "/api/v1/accountOrders": async (q) => {
        if (order.length === 1) await gate; // the first order waits for confirmation
        return {
          code: 200,
          orders: [{ client_order_index: Number(q.get("client_order_indexes")), status: "filled", filled_base_amount: "1", filled_quote_amount: "1" }],
        };
      },
      "/api/v1/trades": () => ({ code: 200, trades: [] }),
    });
    const c = client(http);
    const o = { marketId: 2054, coin: "NVDA/USDG", isBuy: false, price: "1", size: "1", szDecimals: 4, priceDecimals: 2, tif: "Ioc" as const };
    const p1 = c.placeOrder(KEY, o);
    const p2 = c.placeOrder(KEY, o);
    await new Promise((r) => setTimeout(r, 20));
    // the second order on the same key has not even read a nonce while the first is unconfirmed
    expect(order).toEqual(["nonce:254:0"]);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["nonce:254:0", "nonce:254:1"]);
  });
});

describe("KeyedMutex / client order index", () => {
  it("same key strictly sequential, different keys concurrent; a failure does not block the queue", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const task =
      (name: string, ms: number, fail = false) =>
      async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
      };
    await Promise.allSettled([m.run("a", task("a1", 15, true)), m.run("a", task("a2", 1)), m.run("b", task("b1", 1))]);
    expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
    expect(log.indexOf("start b1")).toBeLessThan(log.indexOf("end a1"));
  });
  it("client order indexes are unique, increasing and < 2^48", () => {
    const a = newClientOrderIndex(1_794_416_000_000);
    const b = newClientOrderIndex(1_794_416_000_000);
    expect(b).toBe(a + 1);
    expect(a).toBeLessThan(2 ** 48);
  });
});

describe("auth tokens only on allowlisted GET reads", () => {
  it("refuses to attach a token to a write endpoint", async () => {
    const { http } = mockHttp({});
    await expect(http.get("/api/v1/changeAccountTier", {}, "9:1:2:x")).rejects.toThrow(/refusing/);
    await expect(http.get("/api/v1/fastwithdraw", {}, "9:1:2:x")).rejects.toThrow(/refusing/);
    await expect(http.get("/api/v1/tokens/create", {}, "9:1:2:x")).rejects.toThrow(/refusing/);
  });
});

describe("platform read token", () => {
  it("an endpoint that refuses the platform token (20013 invalid auth) is read without it from then on", async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const auth = init?.headers?.authorization;
      seen.push(auth);
      return auth
        ? { ok: false, status: 400, json: async () => ({ code: 20013, message: "invalid auth" }), text: async () => "" }
        : { ok: true, status: 200, json: async () => ({ code: 200, nonce: 3 }), text: async () => "" };
    };
    const http = new LighterHttp({ baseUrl: "https://x.test", fetchImpl, readToken: "ro:1:all:9:x", sleep: async () => {} });
    expect((await http.get("/api/v1/nextNonce", { account_index: 1, api_key_index: 4 }, "platform")).nonce).toBe(3);
    expect((await http.get("/api/v1/nextNonce", { account_index: 1, api_key_index: 4 }, "platform")).nonce).toBe(3);
    expect(seen).toEqual(["ro:1:all:9:x", undefined, undefined]);
  });
});
