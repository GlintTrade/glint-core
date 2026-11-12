// THE ONLY MODULE THAT SIGNS WITH AN AGENT'S API KEY.
//
// Glint uses the agent key only to create orders, cancel and cancel all; withdrawing isn't part of what the agent
// does. A Lighter API key is a general-purpose L2 key (docs: api-keys) and Lighter has no per-key scopes, so the
// scope is enforced here, in code:
//  1. The signer receives only the AGENT capability of the WASM (wasm.ts): CreateClient, SignCreateOrder,
//     SignCancelOrder, SignCancelAllOrders, CreateAuthToken. No other WASM function is retained.
//  2. Every call goes through call(), which checks AGENT_SIGNER_ALLOWLIST again (even if a wider object is passed).
//  3. Every signed result must carry tx type 14 (create order), 15 (cancel order) or 16 (cancel all); anything
//     else is discarded and throws before it can reach sendTx.
//  4. sendTx for agent transactions (client.ts) accepts only AGENT_TX_TYPES.
// Order fields are validated (positive integers, IOC/GTT only, no trigger orders, default self-trade modes, which
// partner fees require: error 21159).
// Auth tokens (CreateAuthToken) are used only for authenticated GET reads (fills, orders, tier): see http.ts.
import type { AgentWasm, WasmFn } from "./wasm.js";

export const AGENT_SIGNER_ALLOWLIST = Object.freeze(["CreateClient", "SignCreateOrder", "SignCancelOrder", "SignCancelAllOrders", "CreateAuthToken"] as const);
type AllowedFn = (typeof AGENT_SIGNER_ALLOWLIST)[number];

/** Lighter tx types (lighter-go types/txtypes/constants.go). */
export const TX_TYPE = {
  changePubKey: 8,
  createSubAccount: 9,
  transfer: 12,
  withdraw: 13,
  createOrder: 14,
  cancelOrder: 15,
  cancelAllOrders: 16,
  modifyOrder: 17,
  updateLeverage: 20,
  updateMargin: 29,
  approveIntegrator: 45,
} as const;

export const AGENT_TX_TYPES: ReadonlySet<number> = new Set([TX_TYPE.createOrder, TX_TYPE.cancelOrder, TX_TYPE.cancelAllOrders]);

export interface SignedTx {
  txType: number;
  txInfo: string;
  txHash: string;
}

export interface AgentKey {
  privateKey: string;
  apiKeyIndex: number;
  accountIndex: number;
  chainId: number;
}

export interface CreateOrderParams {
  marketIndex: number;
  clientOrderIndex: number; // uint48
  baseAmount: number; // integer, size × 10^size_decimals
  price: number; // integer, price × 10^price_decimals (worst acceptable price for IOC)
  isAsk: boolean;
  orderType: "limit" | "market";
  timeInForce: "ioc" | "gtt";
  orderExpiryMs?: number; // GTT only
  integrator?: { accountIndex: number; takerFee: number; makerFee: number };
}

const MAX_UINT48 = 2 ** 48 - 1;
const isUint = (x: unknown, max = Number.MAX_SAFE_INTEGER): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max;

export class AgentSignerError extends Error {}

export class AgentSigner {
  readonly #fns: Readonly<Record<string, WasmFn>>;
  readonly #key: AgentKey;

  constructor(wasm: AgentWasm, key: AgentKey) {
    // copy only allowlisted functions, whatever object is passed in
    const fns: Record<string, WasmFn> = Object.create(null);
    for (const n of AGENT_SIGNER_ALLOWLIST) {
      const f = (wasm as unknown as Record<string, unknown>)[n];
      if (typeof f !== "function") throw new AgentSignerError(`agent signer: ${n} is not available`);
      fns[n] = f as WasmFn;
    }
    this.#fns = Object.freeze(fns);
    if (!isUint(key.apiKeyIndex, 254) || !isUint(key.accountIndex) || !isUint(key.chainId)) throw new AgentSignerError("agent signer: invalid key reference");
    if (typeof key.privateKey !== "string" || !/^(0x)?[0-9a-fA-F]{40,128}$/.test(key.privateKey))
      throw new AgentSignerError("agent signer: invalid API private key");
    this.#key = { ...key };
  }

  get accountIndex(): number {
    return this.#key.accountIndex;
  }
  get apiKeyIndex(): number {
    return this.#key.apiKeyIndex;
  }

  /** Single entry point into the WASM. Refuses any function outside AGENT_SIGNER_ALLOWLIST. */
  private call(name: string, args: unknown[]): any {
    if (!(AGENT_SIGNER_ALLOWLIST as readonly string[]).includes(name)) throw new AgentSignerError(`agent signer: ${name} is not allowed for agent keys`);
    const f = this.#fns[name as AllowedFn];
    const res = f(...args);
    if (res && typeof res === "object" && typeof res.error === "string" && res.error) throw new AgentSignerError(`agent signer: ${name}: ${res.error}`);
    return res;
  }

  /** Binds the key in the WASM (no network). Synchronous, so it cannot interleave with another agent's signing. */
  private bind(): void {
    const k = this.#key;
    this.call("CreateClient", ["", k.privateKey, k.chainId, k.apiKeyIndex, k.accountIndex]);
  }

  private signed(res: any, expectedType: number): SignedTx {
    const txType = Number(res?.txType);
    if (!AGENT_TX_TYPES.has(txType) || txType !== expectedType) throw new AgentSignerError(`agent signer: refused tx type ${String(res?.txType)}`);
    if (typeof res.txInfo !== "string") throw new AgentSignerError("agent signer: no txInfo");
    return { txType, txInfo: res.txInfo, txHash: String(res.txHash ?? "") };
  }

  signCreateOrder(p: CreateOrderParams, nonce: number): SignedTx {
    if (!isUint(p.marketIndex, 32767)) throw new AgentSignerError("invalid marketIndex");
    if (!isUint(p.clientOrderIndex, MAX_UINT48) || p.clientOrderIndex === 0) throw new AgentSignerError("invalid clientOrderIndex");
    if (!isUint(p.baseAmount, MAX_UINT48) || p.baseAmount === 0) throw new AgentSignerError("invalid baseAmount");
    if (!isUint(p.price, 2 ** 32 - 1) || p.price === 0) throw new AgentSignerError("invalid price");
    if (!isUint(nonce)) throw new AgentSignerError("invalid nonce");
    const orderType = p.orderType === "market" ? 1 : p.orderType === "limit" ? 0 : -1;
    const tif = p.timeInForce === "ioc" ? 0 : p.timeInForce === "gtt" ? 1 : -1;
    if (orderType < 0 || tif < 0) throw new AgentSignerError("invalid order type");
    const expiry = tif === 0 ? 0 : (p.orderExpiryMs ?? 0);
    if (tif === 1 && !(isUint(expiry) && expiry > Date.now() + 5 * 60_000)) throw new AgentSignerError("GTT orders need an expiry ≥ 5 minutes ahead");
    const ig = p.integrator;
    if (ig && (!isUint(ig.accountIndex) || !isUint(ig.takerFee, 1_000_000) || !isUint(ig.makerFee, 1_000_000)))
      throw new AgentSignerError("invalid integrator fields");
    this.bind();
    const res = this.call("SignCreateOrder", [
      p.marketIndex,
      p.clientOrderIndex,
      p.baseAmount,
      p.price,
      p.isAsk ? 1 : 0,
      orderType,
      tif,
      0, // reduceOnly: spot
      0, // triggerPrice: no stop / take-profit orders from agent keys (protective stops run in code)
      expiry,
      ig?.accountIndex ?? 0,
      ig?.takerFee ?? 0,
      ig?.makerFee ?? 0,
      0, // selfTradeBehaviorMode: default (required with non-zero partner fees)
      0, // selfTradeEqualityMode: default
      0, // skipNonce: strict nonce = previous + 1
      nonce,
      this.#key.apiKeyIndex,
      this.#key.accountIndex,
    ]);
    return this.signed(res, TX_TYPE.createOrder);
  }

  /** orderIndex: our client_order_index (≤ 2^48 − 1; exchange order indexes exceed JS safe integers). */
  signCancelOrder(marketIndex: number, orderIndex: number, nonce: number): SignedTx {
    if (!isUint(marketIndex, 32767) || !isUint(orderIndex, MAX_UINT48) || !isUint(nonce)) throw new AgentSignerError("invalid cancel arguments");
    this.bind();
    const res = this.call("SignCancelOrder", [marketIndex, orderIndex, 0, nonce, this.#key.apiKeyIndex, this.#key.accountIndex]);
    return this.signed(res, TX_TYPE.cancelOrder);
  }

  /** Cancels all open orders of the account immediately (all markets). */
  signCancelAllOrders(nonce: number): SignedTx {
    if (!isUint(nonce)) throw new AgentSignerError("invalid nonce");
    this.bind();
    const res = this.call("SignCancelAllOrders", [0, 0, 255, 0, nonce, this.#key.apiKeyIndex, this.#key.accountIndex]);
    return this.signed(res, TX_TYPE.cancelAllOrders);
  }

  /** Auth token for authenticated GET reads; max 8 h (we use 10 min). */
  authToken(deadlineSec = Math.floor(Date.now() / 1000) + 600): string {
    this.bind();
    const res = this.call("CreateAuthToken", [deadlineSec, this.#key.apiKeyIndex, this.#key.accountIndex]);
    if (typeof res?.authToken !== "string" || !res.authToken) throw new AgentSignerError("agent signer: no auth token");
    return res.authToken;
  }
}
