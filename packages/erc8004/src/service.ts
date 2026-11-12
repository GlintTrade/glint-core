// Background registration of agents in the ERC-8004 Identity Registry and the link in AgentHub, both on Robinhood Chain.
//
//   pending --register()--> registering --receipt--> registered --transferFrom()--> transferring --> linking --setAgentIdentity()--> done
//     ^  registry_unavailable (the registry does not accept register() yet)   waiting_gas (the registering key has no ETH for gas)
//     +-- errors: attempts++ with exponential backoff; after maxAttempts the row is failed (AgentView.identity.lastError)
//
// Idempotency: every step first checks the stored tx (its receipt) or the on-chain state (ownerOf,
// AgentHub.getIdentity); a new tx is sent only if there is no previous one or it was dropped.
//
// Who owns the identity NFT: the platform's registering key registers it (and pays gas), then transfers the NFT to the
// AGENT OWNER recorded in AgentHub (ERC8004_TRANSFER_TO_OWNER=true). Per EIP-8004, NFT owner = agent owner.
// The agentURI points to a stable API URL, so nothing has to change after the transfer (setAgentURI is not used).
// If the transfer fails maxAttempts times the NFT stays with the registering key and the AgentHub link is still created.
import { METADATA_KEYS } from "./abi.js";
import type { HubIdentityClient, IdentityRegistryClient } from "./clients.js";
import { textBytes } from "./clients.js";
import { agentUriFor, type Erc8004Config, type Hex } from "./config.js";
import type { IdentityPatch, IdentityRow, IdentityStore } from "./store.js";

/** Minimal logger (pino-compatible signature). */
export interface Erc8004Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/** Read access to the platform's agents. */
export interface Erc8004AgentSource {
  getAgent(agentId: number): { owner: Hex } | undefined;
  /** Activated agents that are not stopped (candidates for an identity). */
  activatedAgentIds(): number[];
}

export interface Erc8004Deps {
  store: IdentityStore;
  agents: Erc8004AgentSource;
  log?: Erc8004Logger;
  now: () => number; // seconds
  ecfg: Erc8004Config;
  hub: { chainId: number; address: Hex };
  registry: IdentityRegistryClient;
  hubIdentity: HubIdentityClient;
}

const POLL_PENDING_SEC = 15;
const UNAVAILABLE_RETRY_SEC = 1800;
const NO_GAS_RETRY_SEC = 300;
const MISSING_TX_GRACE_SEC = 600;

export class Erc8004Service {
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private availableCache?: { ok: boolean; at: number };

  private readonly log: Erc8004Logger;

  constructor(private readonly d: Erc8004Deps) {
    this.log = d.log ?? { info: () => {}, warn: () => {} };
  }

  start(): void {
    if (this.timer) return;
    const run = () => void this.tick().catch((e) => this.log.warn({ err: (e as Error).message }, "erc8004 tick failed"));
    run();
    this.timer = setInterval(run, this.d.ecfg.pollSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Enqueue an agent manually (idempotent). */
  enqueue(agentId: number): boolean {
    return this.d.store.enqueue(
      { agentId, chainId: this.d.ecfg.chainId, registry: this.d.ecfg.registry, agentUri: agentUriFor(this.d.ecfg.publicApiUrl, agentId) },
      this.d.now(),
    );
  }

  /** One pass: pick up new agents and advance every due row by one step. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const id of this.d.agents.activatedAgentIds()) if (!this.d.store.get(id)) this.enqueue(id);
      for (const row of this.d.store.listDue(this.d.now())) {
        try {
          await this.step(row);
        } catch (e) {
          this.fail(row, (e as Error).message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private patch(row: IdentityRow, p: IdentityPatch): void {
    this.d.store.update(row.agentId, p, this.d.now());
    Object.assign(row, p);
  }

  private later(sec: number) {
    return this.d.now() + sec;
  }

  private fail(row: IdentityRow, msg: string): void {
    const attempts = row.attempts + 1;
    const terminal = attempts >= this.d.ecfg.maxAttempts;
    this.log.warn({ agentId: row.agentId, status: row.status, attempts, err: msg }, "erc8004 step failed");
    this.patch(row, {
      attempts,
      lastError: msg.slice(0, 300),
      status: terminal ? "failed" : row.status,
      nextAttemptAt: this.later(Math.min(3600, 30 * 2 ** Math.min(attempts, 7))),
    });
  }

  private async registryAvailable(): Promise<boolean> {
    const t = this.d.now();
    if (this.availableCache && t - this.availableCache.at < 600) return this.availableCache.ok;
    const ok = await this.d.registry.isAvailable();
    this.availableCache = { ok, at: t };
    return ok;
  }

  private async step(row: IdentityRow): Promise<void> {
    const agent = this.d.agents.getAgent(row.agentId);
    if (!agent) return this.patch(row, { status: "failed", lastError: "agent not found" });

    switch (row.status) {
      case "pending":
      case "registry_unavailable":
      case "waiting_gas":
        return this.stepRegister(row);
      case "registering":
        return this.stepAwaitRegister(row);
      case "registered":
        return this.stepTransfer(row, agent.owner);
      case "transferring":
        return this.stepAwaitTransfer(row, agent.owner);
      case "linking":
        return this.stepLink(row);
      default:
        return;
    }
  }

  private async stepRegister(row: IdentityRow): Promise<void> {
    if (!(await this.registryAvailable())) {
      return this.patch(row, {
        status: "registry_unavailable",
        lastError: "the ERC-8004 Identity Registry does not accept register() yet (implementation not upgraded)",
        nextAttemptAt: this.later(UNAVAILABLE_RETRY_SEC),
      });
    }
    if (!(await this.d.registry.hasGas())) {
      return this.patch(row, {
        status: "waiting_gas",
        lastError: `registering key ${this.d.registry.signer} has not enough ${this.d.ecfg.nativeSymbol ?? "ETH"} on ${this.d.ecfg.chainName ?? "the registry chain"} (chain ${this.d.registry.chainId}) for gas`,
        nextAttemptAt: this.later(NO_GAS_RETRY_SEC),
      });
    }
    const metadata = [
      { metadataKey: METADATA_KEYS.agentHub, metadataValue: textBytes(`eip155:${this.d.hub.chainId}:${this.d.hub.address}`) },
      { metadataKey: METADATA_KEYS.agentHubId, metadataValue: textBytes(String(row.agentId)) },
    ];
    const tx = await this.d.registry.sendRegister(row.agentUri, metadata);
    this.log.info({ agentId: row.agentId, tx }, "erc8004 register sent");
    this.patch(row, { status: "registering", registerTx: tx, lastError: null, nextAttemptAt: this.later(POLL_PENDING_SEC) });
  }

  private async stepAwaitRegister(row: IdentityRow): Promise<void> {
    if (!row.registerTx) return this.patch(row, { status: "pending", nextAttemptAt: this.d.now() });
    const r = await this.d.registry.registerResult(row.registerTx);
    if (r.state === "pending") return this.patch(row, { nextAttemptAt: this.later(POLL_PENDING_SEC) });
    if (r.state === "missing") {
      // the tx was dropped from the mempool: resend after a grace period
      if (this.d.now() - row.updatedAt < MISSING_TX_GRACE_SEC) return this.patch(row, { nextAttemptAt: this.later(POLL_PENDING_SEC) });
      return this.patch(row, { status: "pending", registerTx: null, lastError: "register tx was dropped; resending", nextAttemptAt: this.d.now() });
    }
    if (r.state === "reverted") {
      this.patch(row, { status: "pending", registerTx: null });
      throw new Error("register() reverted");
    }
    if (r.state !== "success") return;
    this.log.info({ agentId: row.agentId, erc8004Id: r.erc8004Id }, "erc8004 identity registered");
    this.patch(row, { status: "registered", erc8004Id: r.erc8004Id, nftOwner: r.owner, attempts: 0, lastError: null, nextAttemptAt: this.d.now() });
  }

  private async stepTransfer(row: IdentityRow, agentOwner: Hex): Promise<void> {
    const id = row.erc8004Id!;
    const current = await this.d.registry.ownerOf(id);
    const toOwner = this.d.ecfg.transferToOwner && agentOwner.toLowerCase() !== this.d.registry.signer.toLowerCase();
    if (!toOwner || (current && current.toLowerCase() === agentOwner.toLowerCase()) || row.attempts >= this.d.ecfg.maxAttempts - 1) {
      return this.patch(row, { status: "linking", nftOwner: current ?? row.nftOwner, attempts: 0, nextAttemptAt: this.d.now() });
    }
    if (current && current.toLowerCase() !== this.d.registry.signer.toLowerCase()) {
      // the NFT is held neither by the registering key nor by the owner: leave it alone, just link
      return this.patch(row, { status: "linking", nftOwner: current, nextAttemptAt: this.d.now() });
    }
    const tx = await this.d.registry.sendTransfer(agentOwner, id);
    this.patch(row, { status: "transferring", transferTx: tx, nextAttemptAt: this.later(POLL_PENDING_SEC) });
  }

  private async stepAwaitTransfer(row: IdentityRow, agentOwner: Hex): Promise<void> {
    if (!row.transferTx) return this.patch(row, { status: "registered", nextAttemptAt: this.d.now() });
    const s = await this.d.registry.txState(row.transferTx);
    if (s === "pending") return this.patch(row, { nextAttemptAt: this.later(POLL_PENDING_SEC) });
    if (s === "success") return this.patch(row, { status: "linking", nftOwner: agentOwner, attempts: 0, lastError: null, nextAttemptAt: this.d.now() });
    if (s === "missing" && this.d.now() - row.updatedAt < MISSING_TX_GRACE_SEC) return this.patch(row, { nextAttemptAt: this.later(POLL_PENDING_SEC) });
    this.patch(row, { status: "registered", transferTx: null });
    throw new Error(`transferFrom ${s}`);
  }

  private async stepLink(row: IdentityRow): Promise<void> {
    const id = row.erc8004Id!;
    const linked = async () => {
      const cur = await this.d.hubIdentity.getIdentity(row.agentId);
      return cur.chainId === row.chainId && cur.registry.toLowerCase() === row.registry.toLowerCase() && cur.erc8004Id === id;
    };
    if (row.linkTx) {
      const s = await this.d.hubIdentity.txState(row.linkTx);
      if (s === "pending" || (s === "missing" && this.d.now() - row.updatedAt < MISSING_TX_GRACE_SEC))
        return this.patch(row, { nextAttemptAt: this.later(POLL_PENDING_SEC) });
      if (s === "success" || (await linked())) return this.done(row);
      this.patch(row, { linkTx: null });
      throw new Error(`setAgentIdentity ${s}`);
    }
    if (await linked()) return this.done(row);
    const tx = await this.d.hubIdentity.sendSetIdentity(row.agentId, row.chainId, row.registry, id);
    this.patch(row, { linkTx: tx, nextAttemptAt: this.later(POLL_PENDING_SEC) });
  }

  private done(row: IdentityRow): void {
    this.log.info({ agentId: row.agentId, erc8004Id: row.erc8004Id }, "erc8004 identity linked in AgentHub");
    this.patch(row, { status: "done", attempts: 0, lastError: null });
  }

  row(agentId: number): IdentityRow | undefined {
    return this.d.store.get(agentId);
  }
}
