// Agent API keys on the user's Lighter account: slot selection, the AgentHub address mapping and the onboarding-row store.
//
// AgentHub mapping:
//   createAgent(..., hlAccount, apiWallet, ...)
//   • hlAccount (field name kept for ABI compatibility) = the user's L1 (EVM) address that owns the Lighter account (Lighter account_index is resolved from it);
//   • apiWallet = first 20 bytes of keccak256(raw 40-byte Lighter API public key) — an address-shaped fingerprint
//     of the agent key, so the contract binds the agent to exactly one key.
import { getAddress, type Hex, keccak256, slice } from "viem";

/** RH: indexes 0–3 and 157 are reserved for Lighter's apps (docs: robinhood-chain/overview). 255 = "all keys" query. */
export const API_KEY_RANGES: readonly [number, number][] = [
  [4, 156],
  [158, 254],
];
export const API_KEY_SLOTS = API_KEY_RANGES.reduce((n, [a, b]) => n + (b - a + 1), 0);

export function isUsableKeyIndex(i: number): boolean {
  return API_KEY_RANGES.some(([a, b]) => i >= a && i <= b);
}

const ZERO_KEY = /^0*$/;

/**
 * Free slot: not registered on Lighter (a listed key with a non-zero public key is taken) and not reserved by one of
 * our pending drafts. Picks from the top (254 down) so it does not collide with integrations that use 4, 5, ...
 */
export function pickFreeKeyIndex(registered: { apiKeyIndex: number; publicKey: string }[], reserved: Iterable<number>): number | null {
  const taken = new Set<number>(reserved);
  for (const k of registered) if (!ZERO_KEY.test(k.publicKey.replace(/^0x/, ""))) taken.add(k.apiKeyIndex);
  for (let i = 254; i >= 4; i--) if (isUsableKeyIndex(i) && !taken.has(i)) return i;
  return null;
}

export function normPubKey(pub: string): string {
  const h = pub.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{80}$/.test(h)) throw new Error("Lighter API public key must be 40 bytes of hex");
  return h;
}

/** apiWallet for AgentHub: first 20 bytes of keccak256(public key bytes). */
export function apiWalletOf(publicKey: string): Hex {
  return getAddress(slice(keccak256(`0x${normPubKey(publicKey)}`), 0, 20));
}

export const keyLabel = (apiKeyIndex: number) => `lighter key #${apiKeyIndex}`;

export type StepStatus = "pending" | "submitted" | "done" | "failed" | "stale" | "not_needed" | "declined";

export interface LighterKeyRow {
  apiWallet: Hex; // lower case
  l1Address: Hex;
  accountIndex: number;
  apiKeyIndex: number;
  publicKey: string; // hex, no 0x
  draftId: string | null;
  agentId: number | null;
  cpkNonce: number;
  cpkMessage: string;
  cpkStatus: StepStatus;
  cpkTxHash: string | null;
  cpkError: string | null;
  aiNonce: number | null;
  aiMessage: string | null;
  aiStatus: StepStatus;
  aiTxHash: string | null;
  aiError: string | null;
  aiTakerFee: number;
  aiMakerFee: number;
  aiExpiryMs: number;
  tier: string | null;
  tierStatus: StepStatus;
  tierError: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Persistence of onboarding rows (one per agent key). The production implementation is a SQL table keyed by
 * apiWallet; MemoryLighterKeyStore below is the reference implementation used by tests and examples.
 */
export interface LighterKeyStore {
  insert(row: LighterKeyRow): void;
  update(apiWallet: string, patch: Partial<LighterKeyRow>, nowSec: number): void;
  byWallet(apiWallet: string): LighterKeyRow | null;
  byDraft(draftId: string): LighterKeyRow | null;
  byAccount(accountIndex: number): LighterKeyRow[];
  /**
   * Slots our own drafts/agents hold on the account (two concurrent prepares never pick the same index).
   * Unsigned drafts older than `staleAfterSec` give their slot back: they are marked "stale" first, so a late
   * signature on the old draft is refused (it would overwrite the newer key at that index) and gets a new slot.
   */
  reservedIndexes(accountIndex: number, nowSec: number, staleAfterSec?: number): number[];
  /** Re-point a row to a new key (fresh onboarding for a stale draft). */
  replace(oldApiWallet: string, row: LighterKeyRow): void;
}

export class MemoryLighterKeyStore implements LighterKeyStore {
  private readonly rows = new Map<string, LighterKeyRow>();

  insert(row: LighterKeyRow): void {
    const k = row.apiWallet.toLowerCase();
    if (this.rows.has(k)) throw new Error(`lighter key ${k} already exists`);
    this.rows.set(k, { ...row, apiWallet: k as Hex });
  }

  update(apiWallet: string, patch: Partial<LighterKeyRow>, nowSec: number): void {
    const k = apiWallet.toLowerCase();
    const cur = this.rows.get(k);
    if (!cur) return;
    const { apiWallet: _ignored, ...rest } = patch;
    this.rows.set(k, { ...cur, ...rest, updatedAt: nowSec });
  }

  byWallet(apiWallet: string): LighterKeyRow | null {
    const r = this.rows.get(apiWallet.toLowerCase());
    return r ? { ...r } : null;
  }

  byDraft(draftId: string): LighterKeyRow | null {
    for (const r of this.rows.values()) if (r.draftId === draftId) return { ...r };
    return null;
  }

  byAccount(accountIndex: number): LighterKeyRow[] {
    return [...this.rows.values()].filter((r) => r.accountIndex === accountIndex).map((r) => ({ ...r }));
  }

  reservedIndexes(accountIndex: number, nowSec: number, staleAfterSec = 86_400): number[] {
    for (const r of this.rows.values())
      if (r.accountIndex === accountIndex && r.agentId === null && r.cpkStatus === "pending" && r.createdAt < nowSec - staleAfterSec) {
        r.cpkStatus = "stale";
        r.updatedAt = nowSec;
      }
    return [...this.rows.values()].filter((r) => r.accountIndex === accountIndex && r.cpkStatus !== "stale").map((r) => r.apiKeyIndex);
  }

  replace(oldApiWallet: string, row: LighterKeyRow): void {
    this.rows.delete(oldApiWallet.toLowerCase());
    this.insert(row);
  }
}
