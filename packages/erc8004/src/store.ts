// Per-agent ERC-8004 registration state. IdentityStore is the persistence boundary
// (production uses a database table; MemoryIdentityStore is for tests and local runs).
import type { AgentIdentity } from "@glint/strategy";
import { agentRegistryId, ERC8004_EXPLORERS, type Hex } from "./config.js";

export type IdentityStatus = AgentIdentity["status"];

export interface IdentityRow {
  agentId: number;
  status: IdentityStatus;
  chainId: number;
  registry: Hex;
  agentUri: string;
  erc8004Id: number | null;
  registerTx: Hex | null;
  transferTx: Hex | null;
  linkTx: Hex | null;
  nftOwner: Hex | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type IdentityPatch = Partial<
  Pick<IdentityRow, "status" | "erc8004Id" | "registerTx" | "transferTx" | "linkTx" | "nftOwner" | "attempts" | "nextAttemptAt" | "lastError" | "agentUri">
>;

export interface IdentityStore {
  /** Adds a pending row if none exists (idempotent). Returns true if a row was created. */
  enqueue(row: Pick<IdentityRow, "agentId" | "chainId" | "registry" | "agentUri">, now: number): boolean;
  get(agentId: number): IdentityRow | undefined;
  update(agentId: number, patch: IdentityPatch, now: number): void;
  /** Non-terminal rows whose nextAttemptAt has come. */
  listDue(now: number, limit?: number): IdentityRow[];
}

const TERMINAL: IdentityStatus[] = ["done", "failed"];

export class MemoryIdentityStore implements IdentityStore {
  private readonly rows = new Map<number, IdentityRow>();

  enqueue(row: Pick<IdentityRow, "agentId" | "chainId" | "registry" | "agentUri">, now: number): boolean {
    if (this.rows.has(row.agentId)) return false;
    this.rows.set(row.agentId, {
      ...row,
      status: "pending",
      erc8004Id: null,
      registerTx: null,
      transferTx: null,
      linkTx: null,
      nftOwner: null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  get(agentId: number): IdentityRow | undefined {
    const r = this.rows.get(agentId);
    return r ? { ...r } : undefined;
  }

  update(agentId: number, patch: IdentityPatch, now: number): void {
    const r = this.rows.get(agentId);
    if (!r) return;
    const clean = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v]));
    this.rows.set(agentId, { ...r, ...clean, updatedAt: now });
  }

  listDue(now: number, limit = 20): IdentityRow[] {
    return [...this.rows.values()]
      .filter((r) => !TERMINAL.includes(r.status) && r.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.agentId - b.agentId)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

/** API view of a registration row (AgentView.identity / ListingView.identity). */
export function identityView(row: IdentityRow | undefined, explorerUrl?: string): AgentIdentity | undefined {
  if (!row) return undefined;
  const known = ERC8004_EXPLORERS[row.chainId];
  const explorer = (explorerUrl ?? known?.url)?.replace(/\/+$/, "");
  const nftPath = known?.nftPath ?? ((r: string, id: number) => `/token/${r}/instance/${id}`);
  const v: AgentIdentity = {
    status: row.status,
    chainId: row.chainId,
    registry: row.registry,
    agentRegistry: agentRegistryId(row.chainId, row.registry),
    agentUri: row.agentUri,
    linkedOnChain: row.status === "done",
  };
  if (row.erc8004Id !== null) v.erc8004Id = row.erc8004Id;
  if (row.nftOwner) v.nftOwner = row.nftOwner;
  if (row.registerTx) v.registerTx = row.registerTx;
  if (explorer && row.erc8004Id !== null) v.explorerUrl = `${explorer}${nftPath(row.registry, row.erc8004Id)}`;
  else if (explorer && row.registerTx) v.explorerUrl = `${explorer}/tx/${row.registerTx}`;
  if (row.lastError) v.lastError = row.lastError;
  return v;
}
