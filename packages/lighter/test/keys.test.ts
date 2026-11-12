// Lighter key onboarding format: API-key slots, the AgentHub apiWallet fingerprint, the onboarding-row store and the
// onboarding gateway (the user's L1 signature is verified before anything is sent), with a fake WASM.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { TX_TYPE } from "../src/lighter/agent-signer.js";
import { LighterHttp } from "../src/lighter/http.js";
import { API_KEY_SLOTS, apiWalletOf, isUsableKeyIndex, type LighterKeyRow, MemoryLighterKeyStore, normPubKey, pickFreeKeyIndex } from "../src/lighter/keys.js";
import { LighterOnboardingGateway } from "../src/lighter/onboarding.js";
import type { OnboardingWasm } from "../src/lighter/wasm.js";

const PUB = `0x${"22".repeat(40)}`;

describe("API key slots", () => {
  it("indexes 0-3 and 157 are reserved on RH; 4-156 and 158-254 are usable", () => {
    for (const i of [0, 1, 2, 3, 157, 255]) expect(isUsableKeyIndex(i)).toBe(false);
    for (const i of [4, 156, 158, 254]) expect(isUsableKeyIndex(i)).toBe(true);
    expect(API_KEY_SLOTS).toBe(250);
  });
  it("picks from the top, skipping registered (non-zero public key) and reserved slots", () => {
    expect(pickFreeKeyIndex([], [])).toBe(254);
    expect(pickFreeKeyIndex([{ apiKeyIndex: 254, publicKey: "ab" }], [253])).toBe(252);
    expect(pickFreeKeyIndex([{ apiKeyIndex: 254, publicKey: "0x0000" }], [])).toBe(254); // a zero key is a free slot
    expect(
      pickFreeKeyIndex(
        [],
        Array.from({ length: 255 }, (_, i) => i),
      ),
    ).toBeNull();
  });
});

describe("apiWallet fingerprint for AgentHub", () => {
  it("is the first 20 bytes of keccak256(public key), checksummed; the public key must be 40 bytes", () => {
    const w = apiWalletOf(PUB);
    expect(w).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(apiWalletOf(PUB.slice(2).toUpperCase())).toBe(w);
    expect(normPubKey(PUB)).toBe("22".repeat(40));
    expect(() => normPubKey("0x1234")).toThrow();
  });
});

const row = (o: Partial<LighterKeyRow> = {}): LighterKeyRow => ({
  apiWallet: apiWalletOf(PUB).toLowerCase() as `0x${string}`,
  l1Address: "0x00000000000000000000000000000000000000a1",
  accountIndex: 21897,
  apiKeyIndex: 254,
  publicKey: "22".repeat(40),
  draftId: "d1",
  agentId: null,
  cpkNonce: 0,
  cpkMessage: "m",
  cpkStatus: "pending",
  cpkTxHash: null,
  cpkError: null,
  aiNonce: null,
  aiMessage: null,
  aiStatus: "pending",
  aiTxHash: null,
  aiError: null,
  aiTakerFee: 0,
  aiMakerFee: 0,
  aiExpiryMs: 0,
  tier: null,
  tierStatus: "not_needed",
  tierError: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...o,
});

describe("MemoryLighterKeyStore", () => {
  it("stores by apiWallet (case-insensitive), finds by draft and account, updates", () => {
    const s = new MemoryLighterKeyStore();
    const r = row();
    s.insert(r);
    expect(() => s.insert(r)).toThrow();
    expect(s.byWallet(r.apiWallet.toUpperCase())?.draftId).toBe("d1");
    expect(s.byDraft("d1")?.apiKeyIndex).toBe(254);
    s.update(r.apiWallet, { cpkStatus: "done", agentId: 7 }, 2000);
    expect(s.byWallet(r.apiWallet)).toMatchObject({ cpkStatus: "done", agentId: 7, updatedAt: 2000 });
    expect(s.byAccount(21897)).toHaveLength(1);
  });
  it("unsigned drafts older than a day go stale and give their slot back", () => {
    const s = new MemoryLighterKeyStore();
    s.insert(row());
    s.insert(row({ apiWallet: "0x00000000000000000000000000000000000000b2", apiKeyIndex: 253, draftId: "d2", createdAt: 200_000 }));
    expect(s.reservedIndexes(21897, 100_000).sort()).toEqual([253]);
    expect(s.byDraft("d1")?.cpkStatus).toBe("stale");
  });
});

/** A fake onboarding capability with deterministic messages. */
function fakeOnboarding(): OnboardingWasm {
  return Object.freeze({
    GenerateAPIKey: () => ({ privateKey: `0x${"11".repeat(40)}`, publicKey: PUB }),
    CreateClient: () => ({}),
    SignChangePubKey: (...a: unknown[]) => ({
      txType: TX_TYPE.changePubKey,
      txInfo: JSON.stringify({ Nonce: a[2] }),
      messageToSign: `Register Lighter Account nonce ${a[2]}`,
    }),
    SignApproveIntegrator: (...a: unknown[]) => ({
      txType: TX_TYPE.approveIntegrator,
      txInfo: JSON.stringify({ Nonce: a[7] }),
      messageToSign: `Approve Integrator ${a[0]} nonce ${a[7]}`,
    }),
    CreateAuthToken: () => ({ authToken: "1:2:3:x" }),
  }) as unknown as OnboardingWasm;
}

describe("LighterOnboardingGateway (fake WASM)", () => {
  function gateway() {
    const sent: Record<string, string>[] = [];
    const http = new LighterHttp({
      baseUrl: "https://x.test",
      fetchImpl: async (_url, init) => {
        sent.push(Object.fromEntries(new URLSearchParams(init?.body ?? "")));
        return { ok: true, status: 200, json: async () => ({ code: 200, tx_hash: "t" }), text: async () => "" };
      },
      sleep: async () => {},
    });
    return { gw: new LighterOnboardingGateway({ http, chainId: 466324, wasm: async () => fakeOnboarding() }), sent };
  }
  const k = { privateKey: `0x${"11".repeat(40)}`, publicKey: PUB, accountIndex: 1234, apiKeyIndex: 254 };

  it("generates a key pair", async () => {
    expect(await gateway().gw.generateKey()).toEqual({ privateKey: `0x${"11".repeat(40)}`, publicKey: PUB });
  });

  it("ChangePubKey: only the account owner's signature over the exact message is sent, with L1Sig attached", async () => {
    const { gw, sent } = gateway();
    const msg = await gw.changePubKeyMessage(k, 0);
    const user = privateKeyToAccount(generatePrivateKey());
    const intruder = privateKeyToAccount(generatePrivateKey());
    await expect(
      gw.submitChangePubKey(k, 0, { message: msg, l1Address: user.address, signature: await intruder.signMessage({ message: msg }) }),
    ).rejects.toThrow(/owner/);
    await expect(gw.submitChangePubKey(k, 1, { message: msg, l1Address: user.address, signature: await user.signMessage({ message: msg }) })).rejects.toThrow(
      /changed/,
    );
    expect(sent).toEqual([]);
    const sig = await user.signMessage({ message: msg });
    await gw.submitChangePubKey(k, 0, { message: msg, l1Address: user.address, signature: sig });
    expect(sent).toHaveLength(1);
    expect(sent[0].tx_type).toBe("8");
    expect(JSON.parse(sent[0].tx_info)).toEqual({ Nonce: 0, L1Sig: sig });
  });

  it("ApproveIntegrator: signed by the owner; zero-fee approvals are never sent", async () => {
    const { gw, sent } = gateway();
    const a = { integratorAccountIndex: 777, maxSpotTakerFee: 1000, maxSpotMakerFee: 1000, approvalExpiryMs: 1_810_000_000_000 };
    const user = privateKeyToAccount(generatePrivateKey());
    const msg = await gw.approveIntegratorMessage(k, 1, a);
    await gw.submitApproveIntegrator(k, 1, a, { message: msg, l1Address: user.address, signature: await user.signMessage({ message: msg }) });
    expect(sent[0].tx_type).toBe("45");
    await expect(
      gw.submitApproveIntegrator(k, 2, { ...a, maxSpotTakerFee: 0, maxSpotMakerFee: 0 }, { message: msg, l1Address: user.address, signature: "0x00" }),
    ).rejects.toThrow(/zero-fee/);
    expect(sent).toHaveLength(1);
  });
});
