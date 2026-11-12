// Security: the agent signer can sign ONLY create order / cancel order / cancel all (+ read auth tokens).
// Every other transaction type of the WASM is structurally unreachable through it. Tested with a fake WASM that exposes every
// function, and (when the pinned signer is built: scripts/build-lighter-signer.sh) with the real WASM.
import { existsSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AGENT_SIGNER_ALLOWLIST, AGENT_TX_TYPES, AgentSigner, TX_TYPE } from "../src/lighter/agent-signer.js";
import { LighterClient } from "../src/lighter/client.js";
import { LighterHttp } from "../src/lighter/http.js";
import { LighterOnboardingGateway, verifyUserSignature } from "../src/lighter/onboarding.js";
import { AGENT_WASM_FUNCTIONS, type AgentWasm, loadLighterSigner, ONBOARDING_WASM_FUNCTIONS, splitCapabilities } from "../src/lighter/wasm.js";
import { defaultSignerFiles } from "../src/network.js";

/** Every function lighter-go wasm/main.go registers (v1.0.12). */
const ALL_WASM_FUNCTIONS = [
  "GenerateAPIKey",
  "CreateClient",
  "CheckClient",
  "CreateAuthToken",
  "SignChangePubKey",
  "SignCreateOrder",
  "SignCancelOrder",
  "SignCancelAllOrders",
  "SignTransfer",
  "SignWithdraw",
  "SignUpdateLeverage",
  "SignModifyOrder",
  "SignCreateSubAccount",
  "SignCreatePublicPool",
  "SignUpdatePublicPool",
  "SignMintShares",
  "SignBurnShares",
  "SignStakeAssets",
  "SignUnstakeAssets",
  "SignUpdateMargin",
  "SignCreateGroupedOrders",
  "SignApproveIntegrator",
  "SignUpdateAccountConfig",
  "SignUpdateAccountAssetConfig",
];
const FORBIDDEN = ALL_WASM_FUNCTIONS.filter((f) => !(AGENT_SIGNER_ALLOWLIST as readonly string[]).includes(f));
const TYPE_OF: Record<string, number> = {
  SignChangePubKey: 8,
  SignCreateSubAccount: 9,
  SignTransfer: 12,
  SignWithdraw: 13,
  SignCreateOrder: 14,
  SignCancelOrder: 15,
  SignCancelAllOrders: 16,
  SignModifyOrder: 17,
  SignUpdateLeverage: 20,
  SignUpdateMargin: 29,
  SignApproveIntegrator: 45,
};

/** A fake WASM exposing every function; records calls. */
function fakeWasm(override: Record<string, (...a: unknown[]) => unknown> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const raw: Record<string, (...a: unknown[]) => unknown> = {};
  for (const name of ALL_WASM_FUNCTIONS)
    raw[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      if (override[name]) return override[name](...args);
      if (name === "CreateAuthToken") return { authToken: "1:2:3:abc" };
      if (name === "GenerateAPIKey") return { privateKey: `0x${"11".repeat(40)}`, publicKey: `0x${"22".repeat(40)}` };
      if (name === "CreateClient") return {};
      return {
        txType: TYPE_OF[name] ?? 99,
        txInfo: "{}",
        txHash: "h",
        ...(name === "SignChangePubKey" || name === "SignApproveIntegrator" ? { messageToSign: `msg:${name}:${args.join(",")}` } : {}),
      };
    };
  return { raw, calls };
}

const KEY = { privateKey: `0x${"ab".repeat(40)}`, apiKeyIndex: 254, accountIndex: 1234, chainId: 466324 };
const order = {
  marketIndex: 2054,
  clientOrderIndex: 179_000_000_000_001,
  baseAmount: 400,
  price: 17605,
  isAsk: false,
  orderType: "limit" as const,
  timeInForce: "ioc" as const,
};

describe("WASM capability split", () => {
  it("the agent capability holds exactly the allowlisted functions, nothing else", () => {
    const { agent, onboarding } = splitCapabilities(fakeWasm().raw);
    expect(Object.keys(agent).sort()).toEqual([...AGENT_WASM_FUNCTIONS].sort());
    for (const f of FORBIDDEN) expect(f in agent).toBe(false);
    expect(Object.isFrozen(agent)).toBe(true);
    // onboarding: key generation + ChangePubKey + ApproveIntegrator only — never withdraw/transfer either
    expect(Object.keys(onboarding).sort()).toEqual([...ONBOARDING_WASM_FUNCTIONS].sort());
    for (const f of ["SignWithdraw", "SignTransfer", "SignCreateSubAccount", "SignUpdateLeverage", "SignUpdateMargin", "SignModifyOrder"])
      expect(f in onboarding).toBe(false);
  });
  it("the allowlists are what the security requirement says", () => {
    expect([...AGENT_SIGNER_ALLOWLIST].sort()).toEqual(["CreateAuthToken", "CreateClient", "SignCancelAllOrders", "SignCancelOrder", "SignCreateOrder"]);
    expect([...AGENT_TX_TYPES].sort()).toEqual([TX_TYPE.createOrder, TX_TYPE.cancelOrder, TX_TYPE.cancelAllOrders].sort());
  });
});

describe("AgentSigner: only orders and cancels", () => {
  it("even when handed the FULL wasm object, it keeps only the allowlist and refuses every forbidden function", () => {
    const { raw, calls } = fakeWasm();
    const s = new AgentSigner(raw as unknown as AgentWasm, KEY);
    for (const f of FORBIDDEN) {
      expect(() => (s as unknown as { call(n: string, a: unknown[]): unknown }).call(f, [])).toThrow(/not allowed/);
    }
    expect(calls.filter((c) => FORBIDDEN.includes(c.name))).toEqual([]);
  });

  it("exposes no method for withdrawals, transfers, key or integrator changes, sub-accounts, leverage or margin", () => {
    const methods = new Set<string>();
    for (let p = AgentSigner.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p))
      for (const k of Object.getOwnPropertyNames(p)) methods.add(k);
    const publicOps = [...methods].filter((m) => m.startsWith("sign") || m === "authToken");
    expect(publicOps.sort()).toEqual(["authToken", "signCancelAllOrders", "signCancelOrder", "signCreateOrder", "signed"].sort());
    for (const m of methods) expect(m).not.toMatch(/withdraw|transfer|pubkey|integrator|subaccount|leverage|margin|pool|stake|config|modify/i);
  });

  it("signs a create order: strict nonce, IOC, no reduce-only / trigger, default self-trade modes, integrator fields", () => {
    const { raw, calls } = fakeWasm();
    const s = new AgentSigner(raw as unknown as AgentWasm, KEY);
    const tx = s.signCreateOrder({ ...order, integrator: { accountIndex: 777, takerFee: 100, makerFee: 0 } }, 42);
    expect(tx.txType).toBe(14);
    const c = calls.find((x) => x.name === "SignCreateOrder")!;
    // marketIndex, clientOrderIndex, baseAmount, price, isAsk, orderType, timeInForce, reduceOnly, triggerPrice, orderExpiry,
    // integratorAccountIndex, integratorTakerFee, integratorMakerFee, selfTradeBehaviorMode, selfTradeEqualityMode, skipNonce, nonce, apiKeyIndex, accountIndex
    expect(c.args).toEqual([2054, order.clientOrderIndex, 400, 17605, 0, 0, 0, 0, 0, 0, 777, 100, 0, 0, 0, 0, 42, 254, 1234]);
    // the key is bound with an EMPTY url (no network from the WASM) and the exchange's chain id
    expect(calls.find((x) => x.name === "CreateClient")!.args).toEqual(["", KEY.privateKey, 466324, 254, 1234]);
  });

  it("refuses a signed result whose tx type is not an order/cancel (e.g. a withdrawal smuggled through SignCreateOrder)", () => {
    for (const bad of [8, 12, 13, 20, 29, 45, 9]) {
      const { raw } = fakeWasm({ SignCreateOrder: () => ({ txType: bad, txInfo: "{}", txHash: "h" }) });
      const s = new AgentSigner(raw as unknown as AgentWasm, KEY);
      expect(() => s.signCreateOrder(order, 1)).toThrow(/refused tx type/);
    }
    const { raw } = fakeWasm({ SignCancelOrder: () => ({ txType: 14, txInfo: "{}" }) }); // wrong type for a cancel
    expect(() => new AgentSigner(raw as unknown as AgentWasm, KEY).signCancelOrder(2054, 5, 1)).toThrow(/refused tx type/);
  });

  it("validates order fields (integers, ranges, GTT expiry) and passes WASM errors through", () => {
    const s = new AgentSigner(fakeWasm().raw as unknown as AgentWasm, KEY);
    expect(() => s.signCreateOrder({ ...order, price: 1.5 }, 1)).toThrow();
    expect(() => s.signCreateOrder({ ...order, baseAmount: 0 }, 1)).toThrow();
    expect(() => s.signCreateOrder({ ...order, clientOrderIndex: 2 ** 48 }, 1)).toThrow();
    expect(() => s.signCreateOrder({ ...order, timeInForce: "gtt" }, 1)).toThrow(/expiry/);
    expect(() => s.signCreateOrder(order, -1)).toThrow(/nonce/);
    expect(() => s.signCreateOrder({ ...order, integrator: { accountIndex: 1, takerFee: 2_000_000, makerFee: 0 } }, 1)).toThrow();
    const e = new AgentSigner(fakeWasm({ SignCreateOrder: () => ({ error: "boom" }) }).raw as unknown as AgentWasm, KEY);
    expect(() => e.signCreateOrder(order, 1)).toThrow(/boom/);
    expect(() => new AgentSigner(fakeWasm().raw as unknown as AgentWasm, { ...KEY, apiKeyIndex: 255 })).toThrow();
  });

  it("cancel / cancel all / auth token", () => {
    const { raw, calls } = fakeWasm();
    const s = new AgentSigner(raw as unknown as AgentWasm, KEY);
    expect(s.signCancelOrder(2054, 5, 7).txType).toBe(15);
    expect(s.signCancelAllOrders(8).txType).toBe(16);
    expect(calls.find((c) => c.name === "SignCancelAllOrders")!.args).toEqual([0, 0, 255, 0, 8, 254, 1234]);
    expect(s.authToken(100)).toBe("1:2:3:abc");
  });

  it("the exchange client never sends a non-agent tx type with an agent key", async () => {
    const posts: string[] = [];
    const http = new LighterHttp({
      baseUrl: "https://x.test",
      fetchImpl: async (url) => (posts.push(url), { ok: true, status: 200, json: async () => ({ code: 200 }), text: async () => "" }),
    });
    const c = new LighterClient({
      http,
      chainId: 300,
      isTestnet: true,
      integratorAccountIndex: null,
      agentWasm: async () => fakeWasm().raw as unknown as AgentWasm,
    });
    const send = (c as unknown as { sendAgentTx(tx: { txType: number; txInfo: string; txHash: string }): Promise<unknown> }).sendAgentTx.bind(c);
    for (const t of [8, 9, 12, 13, 17, 20, 29, 45]) await expect(send({ txType: t, txInfo: "{}", txHash: "" })).rejects.toThrow(/refusing/);
    expect(posts).toEqual([]);
  });
});

// ---------- the real pinned WASM (built by scripts/build-lighter-signer.sh; skipped when absent) ----------
const signerFiles = defaultSignerFiles();
const haveWasm = existsSync(signerFiles.wasmPath) && existsSync(signerFiles.wasmExecPath);

describe.skipIf(!haveWasm)("real lighter-go WASM signer (v1.0.12, sha256-pinned)", () => {
  it("after loading, no WASM function is left on globalThis; the agent capability signs orders only", async () => {
    const caps = await loadLighterSigner(signerFiles);
    const g = globalThis as Record<string, unknown>;
    for (const f of ALL_WASM_FUNCTIONS) expect(g[f]).toBeUndefined();
    expect(Object.keys(caps.agent).sort()).toEqual([...AGENT_WASM_FUNCTIONS].sort());
    const { privateKey } = caps.onboarding.GenerateAPIKey();
    const s = new AgentSigner(caps.agent, { privateKey, apiKeyIndex: 254, accountIndex: 1234, chainId: 300 });
    const tx = s.signCreateOrder({ ...order, integrator: { accountIndex: 777, takerFee: 100, makerFee: 0 } }, 9);
    const info = JSON.parse(tx.txInfo);
    expect(tx.txType).toBe(14);
    expect(info).toMatchObject({
      AccountIndex: 1234,
      ApiKeyIndex: 254,
      MarketIndex: 2054,
      BaseAmount: 400,
      Price: 17605,
      IsAsk: 0,
      TimeInForce: 0,
      ReduceOnly: 0,
      TriggerPrice: 0,
      Nonce: 9,
    });
    expect(info.L2TxAttributes).toEqual({ 1: 777, 2: 100 }); // zero maker fee omitted
    expect(s.signCancelOrder(2054, order.clientOrderIndex, 10).txType).toBe(15);
    expect(s.signCancelAllOrders(11).txType).toBe(16);
    expect(s.authToken(Math.floor(Date.now() / 1000) + 600)).toMatch(/^\d+:1234:254:[0-9a-f]+$/);
  });

  it("onboarding: ChangePubKey / ApproveIntegrator messages; the L1 signature (personal_sign) is verified and attached", async () => {
    const caps = await loadLighterSigner(signerFiles);
    const { privateKey, publicKey } = caps.onboarding.GenerateAPIKey();
    const sent: Record<string, string>[] = [];
    const http = new LighterHttp({
      baseUrl: "https://x.test",
      fetchImpl: async (_url, init) => (
        sent.push(Object.fromEntries(new URLSearchParams(init?.body ?? ""))),
        { ok: true, status: 200, json: async () => ({ code: 200, tx_hash: "t" }), text: async () => "" }
      ),
    });
    const gw = new LighterOnboardingGateway({ http, chainId: 466324, wasm: async () => caps.onboarding });
    const k = { privateKey, publicKey, accountIndex: 1234, apiKeyIndex: 254 };
    const msg = await gw.changePubKeyMessage(k, 0);
    expect(msg).toContain("Register Lighter Account");
    expect(msg).toContain(publicKey.replace(/^0x/, ""));
    expect(msg).not.toMatch(/expired/i); // no expiry in the L1 message: the L2 part is re-signed at submission
    const user = privateKeyToAccount(generatePrivateKey());
    const intruder = privateKeyToAccount(generatePrivateKey());
    await expect(
      gw.submitChangePubKey(k, 0, { message: msg, l1Address: user.address, signature: await intruder.signMessage({ message: msg }) }),
    ).rejects.toThrow(/owner/);
    await expect(gw.submitChangePubKey(k, 1, { message: msg, l1Address: user.address, signature: await user.signMessage({ message: msg }) })).rejects.toThrow(
      /changed/,
    );
    const sig = await user.signMessage({ message: msg });
    expect(await verifyUserSignature(user.address, msg, sig)).toBe(true);
    await gw.submitChangePubKey(k, 0, { message: msg, l1Address: user.address, signature: sig });
    expect(sent).toHaveLength(1);
    expect(sent[0].tx_type).toBe("8");
    expect(JSON.parse(sent[0].tx_info)).toMatchObject({ AccountIndex: 1234, ApiKeyIndex: 254, Nonce: 0, L1Sig: sig });

    const a = { integratorAccountIndex: 777, maxSpotTakerFee: 1000, maxSpotMakerFee: 1000, approvalExpiryMs: 1_810_000_000_000 };
    const aiMsg = await gw.approveIntegratorMessage(k, 1, a);
    expect(aiMsg).toContain("Approve Integrator");
    expect(aiMsg).toContain("chainId: 0x0000000000071d94"); // 466324
    await gw.submitApproveIntegrator(k, 1, a, { message: aiMsg, l1Address: user.address, signature: await user.signMessage({ message: aiMsg }) });
    expect(sent[1].tx_type).toBe("45");
    await expect(
      gw.submitApproveIntegrator(k, 2, { ...a, maxSpotTakerFee: 0, maxSpotMakerFee: 0 }, { message: aiMsg, l1Address: user.address, signature: "0x00" }),
    ).rejects.toThrow(/zero-fee/);
  });
});
