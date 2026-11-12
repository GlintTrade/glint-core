import { randomBytes } from "node:crypto";
import { MemoryLighterKeyStore } from "@glint/lighter";
import { PRESETS } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { decryptSecret, EncryptedKeyVault, encryptSecret, safeEqualHex, sha256Hex } from "../src/keys.js";
import { addAgent, fakeLighterKey, makeWorld } from "./helpers.js";

const K = "11".repeat(32);
const K2 = "22".repeat(32);

describe("AES-256-GCM for agent Lighter API keys", () => {
  it("round trip; the key is not in the ciphertext", () => {
    const pk = `0x${randomBytes(40).toString("hex")}`;
    const aad = "0x00000000000000000000000000000000000000aa";
    const blob = encryptSecret(pk, K, aad);
    expect(blob).not.toContain(pk.slice(2));
    expect(blob.startsWith("v1:")).toBe(true);
    expect(decryptSecret(blob, K, aad)).toBe(pk);
  });
  it("random IV: two ciphertexts differ", () => {
    expect(encryptSecret("x", K)).not.toBe(encryptSecret("x", K));
  });
  it("wrong master key, wrong AAD or a tampered ciphertext -> error", () => {
    const blob = encryptSecret("secret", K, "0xabc");
    expect(() => decryptSecret(blob, K2, "0xabc")).toThrow();
    expect(() => decryptSecret(blob, K, "0xdef")).toThrow();
    const parts = blob.split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString("base64");
    expect(() => decryptSecret(parts.join(":"), K, "0xabc")).toThrow();
  });
  it("the master key format is checked; a 0x prefix is accepted", () => {
    expect(() => encryptSecret("x", "short")).toThrow(/MASTER_KEY/);
    expect(decryptSecret(encryptSecret("x", `0x${K}`), K)).toBe("x");
  });
  it("sha256Hex and constant-time hex comparison", () => {
    const h = sha256Hex("glint");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(safeEqualHex(h, sha256Hex("glint"))).toBe(true);
    expect(safeEqualHex(h, sha256Hex("other"))).toBe(false);
    expect(safeEqualHex("ab", "abcd")).toBe(false);
  });
});

describe("EncryptedKeyVault", () => {
  it("stores only ciphertext bound to the apiWallet and returns the key with its Lighter slot", async () => {
    const w = await makeWorld();
    const spec = {
      ...PRESETS[0]!.defaults.balanced,
      version: 1 as const,
      preset: PRESETS[0]!.key,
      name: "n",
      goal: "",
      markets: ["NVDA"],
      quote: "USDG" as const,
      model: "model-a",
      intervalSec: 300,
      profile: "balanced" as const,
    };
    const k = addAgent(w, { id: 1, spec });
    const ref = await w.keys.agentKey({ id: 1, apiWallet: k.apiWallet });
    expect(ref).toEqual({ accountIndex: k.accountIndex, apiKeyIndex: k.apiKeyIndex, privateKey: k.privateKey });
  });

  it("unknown key, missing slot row and a bad master key fail loudly", async () => {
    const blobs = new Map<string, string>();
    const rows = new MemoryLighterKeyStore();
    const vault = new EncryptedKeyVault(K, rows, blobs);
    const k = fakeLighterKey();
    vault.put(k.apiWallet, k.privateKey);
    expect([...blobs.values()][0]).not.toContain(k.privateKey.slice(2));
    await expect(vault.agentKey({ id: 1, apiWallet: k.apiWallet })).rejects.toThrow(/no Lighter key slot/);
    await expect(vault.agentKey({ id: 2, apiWallet: fakeLighterKey().apiWallet })).rejects.toThrow(/no key stored/);
    expect(() => new EncryptedKeyVault("short", rows)).toThrow(/MASTER_KEY/);
  });
});
