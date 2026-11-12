// Agent API keys. Each agent gets its own Lighter API key on the user's account; the user registers it with a
// ChangePubKey signed by their own wallet (see onboarding in @glint/lighter). Glint uses the key only to create
// orders, cancel and cancel all; withdrawing isn't part of what the agent does (the agent signer exposes only those
// transaction types, see agent-signer.ts in @glint/lighter).
//
// The private key is stored encrypted with AES-256-GCM; the ciphertext is bound to the key's apiWallet fingerprint
// (AAD), so a blob cannot be moved to another agent. The master key comes from the runner's environment.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentKeyRef, LighterKeyStore } from "@glint/lighter";
import { type AgentRecord, type Hex, lc } from "./types.js";

const VERSION = "v1";

function keyBytes(masterKeyHex: string): Buffer {
  const hex = masterKeyHex.startsWith("0x") ? masterKeyHex.slice(2) : masterKeyHex;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("MASTER_KEY must be 32 bytes of hex");
  return Buffer.from(hex, "hex");
}

/** Format: v1:<iv b64>:<tag b64>:<ciphertext b64>. `aad` binds the ciphertext to a context (the apiWallet). */
export function encryptSecret(plain: string, masterKeyHex: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(masterKeyHex), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(blob: string, masterKeyHex: string, aad?: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unknown ciphertext format");
  const [, ivB, tagB, ctB] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(masterKeyHex), Buffer.from(ivB, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Source of the agent's Lighter key used to sign orders. The key is decrypted only for the duration of a call. */
export interface KeyVault {
  agentKey(agent: Pick<AgentRecord, "id" | "apiWallet">): Promise<AgentKeyRef>;
}

/**
 * KeyVault over encrypted blobs keyed by the lowercase apiWallet. The slot (account index, API key index) comes
 * from the onboarding rows (LighterKeyStore). The blob map is injectable so it can be backed by any storage; only
 * ciphertext is ever stored.
 */
export class EncryptedKeyVault implements KeyVault {
  constructor(
    private readonly masterKeyHex: string,
    private readonly keyRows: Pick<LighterKeyStore, "byWallet">,
    private readonly blobs: Map<string, string> = new Map(),
  ) {
    keyBytes(masterKeyHex); // validate early
  }

  /** Encrypt and store the private key of the agent key with this apiWallet. Returns the ciphertext. */
  put(apiWallet: Hex, privateKey: string): string {
    const blob = encryptSecret(privateKey, this.masterKeyHex, lc(apiWallet));
    this.blobs.set(lc(apiWallet), blob);
    return blob;
  }

  async agentKey(agent: Pick<AgentRecord, "id" | "apiWallet">): Promise<AgentKeyRef> {
    const blob = this.blobs.get(lc(agent.apiWallet));
    if (!blob) throw new Error(`no key stored for agent #${agent.id}`);
    const row = this.keyRows.byWallet(agent.apiWallet);
    if (!row) throw new Error(`no Lighter key slot recorded for agent #${agent.id}`);
    return { accountIndex: row.accountIndex, apiKeyIndex: row.apiKeyIndex, privateKey: decryptSecret(blob, this.masterKeyHex, lc(agent.apiWallet)) };
  }
}
