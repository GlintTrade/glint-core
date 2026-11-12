// Persistence boundary of the runner. The production backend implements RunnerStore on a database;
// MemoryStore is a complete in-memory implementation used by tests and local experiments.
import { type ExchangeClient, parseSpotUsdgMarkets, type ResolvedMarket, type SyncedMarket } from "@glint/lighter";
import { type ModelInfo, PRESETS, type PresetInfo, type StrategySpec } from "@glint/strategy";
import type { UsageRecord, UsageSink } from "./llm/router.js";
import {
  type AgentCapital,
  type AgentRecord,
  type AgentState,
  type DecisionRow,
  type EpochRow,
  type Hex,
  lc,
  type NewTrade,
  type OffchainStatus,
  type TradeRow,
} from "./types.js";

export interface RunnerStore {
  // ---------- agents ----------
  getAgent(id: number): AgentRecord | undefined;
  listAgents(filter?: { activatedOnly?: boolean }): AgentRecord[];
  /** activated, on-chain Active and off-chain "ok". */
  listRunnableAgents(): AgentRecord[];
  setAgentState(id: number, state: AgentState): void;
  setAgentChainStatus(id: number, status: number): void;
  setOffchainStatus(id: number, status: OffchainStatus, reason: string | null): void;
  setProtectOnly(id: number, on: boolean): void;

  // ---------- platform data ----------
  getPresetById(id: number): PresetInfo | undefined;
  listMarkets(): ResolvedMarket[];
  listModels(): ModelInfo[];

  // ---------- capital ----------
  getCapital(agentId: number): AgentCapital | undefined;
  setAdopted(agentId: number, adopted: Record<string, number>, nowSec: number): void;

  // ---------- trades, decisions, epochs ----------
  insertTrade(t: NewTrade): number;
  /** Trades of one agent, oldest first. */
  allTradesAsc(agentId: number): TradeRow[];
  countTradesSince(agentId: number, sinceSec: number): number;
  unrecordedTrades(limit: number): TradeRow[];
  markTradesRecorded(ids: number[], txHash: Hex): void;
  insertDecision(row: Omit<DecisionRow, "id">): void;
  insertEpoch(agentId: number, equityUsd: number, pnlBps: number, ts: number): void;
  unrecordedEpochs(limit: number): EpochRow[];
  markEpochsRecorded(ids: number[], txHash: Hex): void;
}

/** A store that can take a fresh market sync (optional part of RunnerStore). */
export interface MarketSyncTarget {
  /**
   * Replace market data with a fresh sync. Enabling is automatic: a pair is enabled while its 24h volume is at least
   * minDayVolumeUsd; a pinned market (setMarketEnabled) keeps its state. Markets missing from the sync become unresolved.
   */
  upsertMarkets(rows: SyncedMarket[], at: number, minDayVolumeUsd: number): void;
}

/** Fields of an agent that come from the AgentHub contract. */
export type ChainAgentFields = Pick<
  AgentRecord,
  | "id"
  | "owner"
  | "presetId"
  | "locked"
  | "chainStatus"
  | "intervalSec"
  | "createdAt"
  | "sourceAgentId"
  | "specHash"
  | "modelId"
  | "hlAccount"
  | "apiWallet"
  | "risk"
>;

type StoredMarket = ResolvedMarket & { pinned?: boolean };

export class MemoryStore implements RunnerStore, UsageSink, MarketSyncTarget {
  private agents = new Map<number, AgentRecord>();
  private presets: PresetInfo[];
  private markets = new Map<string, StoredMarket>();
  private models: ModelInfo[];
  private capital = new Map<number, AgentCapital>();
  private trades: TradeRow[] = [];
  private decisions: DecisionRow[] = [];
  private epochs: EpochRow[] = [];
  readonly usage: UsageRecord[] = [];
  private seq = 0;

  constructor(opts: { presets?: PresetInfo[]; models?: ModelInfo[]; markets?: ResolvedMarket[] } = {}) {
    this.presets = structuredClone(opts.presets ?? PRESETS);
    this.models = structuredClone(opts.models ?? []);
    for (const m of opts.markets ?? []) this.markets.set(m.symbol, { ...m });
  }

  private next(): number {
    return ++this.seq;
  }
  private copy<T>(x: T): T {
    return structuredClone(x);
  }

  // ---------- agents ----------

  /** Insert or update the on-chain fields of an agent; off-chain fields are kept. */
  upsertChainAgent(a: ChainAgentFields): void {
    const prev = this.agents.get(a.id);
    this.agents.set(a.id, {
      spec: null,
      activated: false,
      activatedAt: null,
      offchainStatus: "ok",
      pauseReason: null,
      protectOnly: false,
      state: {},
      ...prev,
      ...this.copy(a),
      owner: lc(a.owner),
      hlAccount: lc(a.hlAccount),
      apiWallet: lc(a.apiWallet),
    });
  }

  /** Attach the off-chain spec and mark the agent activated (after the on-chain record and the Lighter key were checked). */
  activateAgent(id: number, spec: StrategySpec, nowSec = Math.floor(Date.now() / 1000)): void {
    const a = this.require(id);
    a.spec = this.copy(spec);
    a.activated = true;
    a.activatedAt = a.activatedAt ?? nowSec;
  }

  private require(id: number): AgentRecord {
    const a = this.agents.get(id);
    if (!a) throw new Error(`agent #${id} not found`);
    return a;
  }

  getAgent(id: number): AgentRecord | undefined {
    const a = this.agents.get(id);
    return a ? this.copy(a) : undefined;
  }
  listAgents(filter: { activatedOnly?: boolean } = {}): AgentRecord[] {
    return [...this.agents.values()]
      .filter((a) => !filter.activatedOnly || a.activated)
      .sort((x, y) => x.id - y.id)
      .map((a) => this.copy(a));
  }
  listRunnableAgents(): AgentRecord[] {
    return this.listAgents({ activatedOnly: true }).filter((a) => a.chainStatus === 0 && a.offchainStatus === "ok");
  }
  setAgentState(id: number, state: AgentState): void {
    this.require(id).state = this.copy(state);
  }
  setAgentChainStatus(id: number, status: number): void {
    this.require(id).chainStatus = status;
  }
  setOffchainStatus(id: number, status: OffchainStatus, reason: string | null): void {
    const a = this.require(id);
    a.offchainStatus = status;
    a.pauseReason = reason;
  }
  setProtectOnly(id: number, on: boolean): void {
    this.require(id).protectOnly = on;
  }

  // ---------- platform data ----------

  getPresetById(id: number): PresetInfo | undefined {
    const p = this.presets.find((x) => x.id === id);
    return p ? this.copy(p) : undefined;
  }
  setPresets(presets: PresetInfo[]): void {
    this.presets = this.copy(presets);
  }
  listMarkets(): ResolvedMarket[] {
    return [...this.markets.values()].map(({ pinned: _p, ...m }) => ({ ...m }));
  }
  upsertMarkets(rows: SyncedMarket[], at: number, minDayVolumeUsd = 0): void {
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.symbol);
      const prev = this.markets.get(r.symbol);
      const auto = (r.dayVolumeUsd ?? 0) >= minDayVolumeUsd;
      const pinned = !!prev?.pinned;
      this.markets.set(r.symbol, { ...r, enabled: pinned ? (prev?.enabled ?? auto) : auto, pinned, lastSyncAt: at });
    }
    for (const m of this.markets.values()) {
      if (!seen.has(m.symbol))
        Object.assign(m, { resolved: false, hlSpotIndex: -1, coin: "", dayVolumeUsd: 0, midUsd: 0, markPx: 0, prevDayPx: 0, lastSyncAt: at });
    }
  }
  /** Pin a market on or off (e.g. to simulate a delisted pair); a pinned market is not changed by later syncs. */
  setMarketEnabled(symbol: string, enabled: boolean): void {
    const m = this.markets.get(symbol);
    if (m) Object.assign(m, { enabled, pinned: true });
  }
  listModels(): ModelInfo[] {
    return this.copy(this.models);
  }
  setModels(models: ModelInfo[]): void {
    this.models = this.copy(models);
  }

  // ---------- capital ----------

  getCapital(agentId: number): AgentCapital | undefined {
    const c = this.capital.get(agentId);
    return c ? this.copy(c) : undefined;
  }
  setCapital(agentId: number, allocationUsd: number | null, keyLabel: string | null = null, nowSec = 0): void {
    const prev = this.capital.get(agentId);
    this.capital.set(agentId, { agentId, allocationUsd, keyLabel, adopted: prev?.adopted ?? {}, updatedAt: nowSec });
  }
  setAdopted(agentId: number, adopted: Record<string, number>, nowSec: number): void {
    const prev = this.capital.get(agentId) ?? { agentId, allocationUsd: null, keyLabel: null, adopted: {}, updatedAt: 0 };
    this.capital.set(agentId, { ...prev, adopted: { ...adopted }, updatedAt: nowSec });
  }

  // ---------- trades ----------

  insertTrade(t: NewTrade): number {
    const id = this.next();
    this.trades.push({ ...t, owner: lc(t.owner), id, recorded: false, txHash: null });
    return id;
  }
  allTradesAsc(agentId: number): TradeRow[] {
    return this.trades
      .filter((t) => t.agentId === agentId)
      .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
      .map((t) => ({ ...t }));
  }
  /** Newest first. */
  listTrades(agentId: number, limit = 50): TradeRow[] {
    return this.allTradesAsc(agentId).reverse().slice(0, limit);
  }
  countTradesSince(agentId: number, sinceSec: number): number {
    return this.trades.filter((t) => t.agentId === agentId && t.timestamp >= sinceSec).length;
  }
  unrecordedTrades(limit = 100): TradeRow[] {
    return this.trades
      .filter((t) => !t.recorded)
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }
  markTradesRecorded(ids: number[], txHash: Hex): void {
    const set = new Set(ids);
    for (const t of this.trades) if (set.has(t.id)) Object.assign(t, { recorded: true, txHash });
  }

  // ---------- decisions ----------

  insertDecision(row: Omit<DecisionRow, "id">): void {
    this.decisions.push({ ...this.copy(row), id: this.next() });
  }
  /** Newest first. */
  lastDecisions(agentId: number, limit = 20): DecisionRow[] {
    return this.decisions
      .filter((d) => d.agentId === agentId)
      .reverse()
      .slice(0, limit)
      .map((d) => this.copy(d));
  }

  // ---------- epochs ----------

  insertEpoch(agentId: number, equityUsd: number, pnlBps: number, ts: number): void {
    this.epochs.push({ id: this.next(), agentId, equityUsd, pnlBps, ts, recorded: false, txHash: null });
  }
  unrecordedEpochs(limit = 100): EpochRow[] {
    return this.epochs
      .filter((e) => !e.recorded)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }
  markEpochsRecorded(ids: number[], txHash: Hex): void {
    const set = new Set(ids);
    for (const e of this.epochs) if (set.has(e.id)) Object.assign(e, { recorded: true, txHash });
  }

  // ---------- LLM usage (UsageSink) ----------

  recordUsage(u: UsageRecord): void {
    this.usage.push({ ...u });
  }
  /** Total AI cost since `sinceSec` (optionally for one agent). */
  llmCostSince(sinceSec: number, agentId?: number): number {
    return this.usage.filter((u) => u.ts >= sinceSec && (agentId === undefined || u.agentId === agentId)).reduce((s, u) => s + u.costUsd, 0);
  }
}

/** Mid prices by base symbol for the known, resolved markets (the exchange keys mids by pair, e.g. "NVDA/USDG"). */
export function midsBySymbol(all: Record<string, number>, markets: Pick<ResolvedMarket, "symbol" | "coin" | "resolved">[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of markets) {
    const px = all[m.coin] ?? 0;
    if (m.resolved && px > 0) out[m.symbol] = px;
  }
  return out;
}

/**
 * Pulls every Lighter spot pair quoted in USDG and writes it to a MarketSyncTarget.
 * A pair is enabled automatically once its 24h volume reaches minMarketDayVolumeUsd.
 */
export async function syncMarkets(
  target: MarketSyncTarget,
  exchange: Pick<ExchangeClient, "spotMarkets">,
  opts: { minMarketDayVolumeUsd: number; nowSec: number },
): Promise<SyncedMarket[]> {
  const rows = parseSpotUsdgMarkets(await exchange.spotMarkets());
  if (rows.length === 0) throw new Error("orderBookDetails has no USDG spot pairs");
  target.upsertMarkets(rows, opts.nowSec, opts.minMarketDayVolumeUsd);
  return rows;
}
