// Runner: the agent decision loop. Every config.runner.tickSec (15 s) for every runnable agent:
//  1) skip unless the agent is Active on-chain, activated, its key is registered on Lighter and it is not paused off-chain;
//  2) protective stops and preset exit rules (code, not AI) are checked EVERY tick and executed immediately;
//  3) when a decision is due (intervalSec) and a cheap trigger fires: context -> AI -> risk engine -> liquidity guard
//     -> IOC orders signed by the agent's Lighter API key;
//  4) receipts: filled trades are batched into TradeRecorded receipts (~30 s), equity epochs into EpochRecorded (hourly).
// Exchange: Lighter on Robinhood Chain, spot pairs SYMBOL/USDG. Orders are IOC limits at the slippage-capped price,
// signed only through the agent signer of @glint/lighter: Glint uses the key only to create orders, cancel and cancel
// all; withdrawing isn't part of what the agent does.
// Receipts: hlOrderId (historical AgentHub field name) = the Lighter client_order_index the runner assigns (uint48);
// the exchange order id and the sendTx hash stay off-chain on the trade row.
// No preset-specific logic: rights come from allowsBuy/allowsSell, stops from preset.protection,
// indicators from preset.indicators, the prompt from preset.promptTemplate, rules from preset.rules.
import { batches, type HubClient, type OnchainAgent, type ReceiptSink, toEpochReceipt, toTradeReceipt } from "@glint/agenthub";
import { computeIndicators, resolveIndicatorSpecs, TIMEFRAME_MS } from "@glint/indicators";
import {
  type AgentKeyRef,
  type Candle,
  type ExchangeClient,
  type LighterKeyStore,
  marketOpenState,
  type OrderBook,
  parseSpotUsdgMarkets,
  QUOTE,
  type ResolvedMarket,
  type SpotBalance,
} from "@glint/lighter";
import {
  type ApprovedOrder,
  avgEntryFromTrades,
  checkLiquidity,
  checkProtection,
  computeEquity,
  describeConditions,
  evalConditions,
  evaluateDecision,
  indicatorLabels,
  indicatorValues,
  nearProtection,
  numParam,
  type Position,
  type Rejection,
  type RiskInput,
  rebalancePlan,
  updatePeaks,
  weightsParam,
} from "@glint/risk";
import { type AgentAction, type AgentDecision, isAllMarkets, MIN_ORDER_MARGIN, type ModelInfo, type PresetInfo, type StrategySpec } from "@glint/strategy";
import { type ApprovalState, checkLighterApprovals, type IntegratorConfig, integratorForOrder, NO_INTEGRATOR } from "./approvals.js";
import { TtlCache } from "./cache.js";
import type { CapitalResult } from "./capital/ledger.js";
import { computeAgentCapital } from "./capital/service.js";
import type { RunnerConfig } from "./config.js";
import { EquityRecorder } from "./equity.js";
import type { KeyVault } from "./keys.js";
import type { DecisionContext, MarketContext } from "./llm/prompt.js";
import { aiUnavailableNote, type LlmRouter } from "./llm/router.js";
import { type Logger, noopLogger } from "./log.js";
import { type MarketSyncTarget, midsBySymbol, type RunnerStore } from "./store.js";
import { type AgentRecord, type AgentState, type Hex, lc } from "./types.js";
import { affordableBuy, agentUniverse, heldSymbols, minSellShareBps, POSITION_DUST_USD, type UniverseMarket } from "./universe.js";

export type TickOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "protect"; orders: ApprovedOrder[]; filled: number; rejections: Rejection[] }
  | { kind: "not_due" }
  | { kind: "no_trigger" }
  | { kind: "decided"; ok: boolean; decision: AgentDecision; orders: ApprovedOrder[]; filled: number; rejections: Rejection[]; provider: string };

export interface Snapshot {
  /** The agent's markets this tick: its pairs (or the "*" shortlist) plus held positions. buyable = may buy. */
  markets: UniverseMarket[];
  mids: Record<string, number>;
  balances: { usdc: number; tokens: Record<string, number> };
  positions: Position[];
  equity: number;
  /** The agent's sub-account on the shared Lighter account. ok=false: the agent needs a capital allocation. */
  capital?: CapitalResult;
  /** Enabled markets left out of the agent's set because of capital/lot size ("*" mode). */
  unbuyable?: Record<string, "min_order">;
}

export interface RunnerDeps {
  store: RunnerStore;
  /** Lighter on Robinhood Chain (spot). */
  exchange: ExchangeClient;
  /** Onboarding rows of the agent keys: which account and API key slot each apiWallet is. */
  keyRows: Pick<LighterKeyStore, "byWallet">;
  /** AgentHub reads (agent status, apiWallet, premium). */
  hub: HubClient;
  /** Where TradeRecorded / EpochRecorded receipts are written. Without it receipts stay unrecorded in the store. */
  receipts?: ReceiptSink;
  llm: LlmRouter;
  keys: KeyVault;
  config: RunnerConfig;
  /** The platform's Lighter integrator (partner) account and fee. Default: none (no attribution, zero fee). */
  integrator?: IntegratorConfig;
  log?: Logger;
  /** Current time, unix seconds. */
  now?: () => number;
  /** Premium status of an owner. Default: AgentHub.isPremium when the hub is enabled (cached 60 s), else false. */
  isPremium?: (owner: Hex) => Promise<boolean>;
  /** Platform minimum decision interval for non-premium owners. Default 300 s. */
  minIntervalSec?: number;
  /** Equity series sink (at most one point per minute per agent, and right after a trade), e.g. for an equity chart. */
  onEquity?: (agentId: number, ts: number, equityUsd: number) => void;
}

const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const dayStartSec = (sec: number) => Math.floor(sec / 86400) * 86400;

export class Runner {
  readonly cache = new TtlCache();
  private readonly approvals = new Map<number, { ok: boolean; exp: number; problems: string[]; integrator: ApprovalState["integrator"] }>();
  private readonly tiers = new Map<number, { tier: string | null; exp: number }>();
  private readonly candleCache = new Map<string, { at: number; candles: Candle[] }>();
  private readonly equity: EquityRecorder;
  private readonly log: Logger;
  private readonly now: () => number;
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(private readonly d: RunnerDeps) {
    this.log = d.log ?? noopLogger;
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.equity = new EquityRecorder(d.onEquity);
  }

  private get cfg(): RunnerConfig {
    return this.d.config;
  }

  private get integrator(): IntegratorConfig {
    return this.d.integrator ?? NO_INTEGRATOR;
  }

  // ---------- data ----------

  /** Mid prices by symbol for known markets (cached 5 s). */
  async midsBySymbol(): Promise<Record<string, number>> {
    const all = await this.cache.get("exchange:mids", 5_000, () => this.d.exchange.allMids());
    return midsBySymbol(all, this.d.store.listMarkets());
  }

  /**
   * Syncs every Lighter spot pair quoted in USDG into the store, when the store supports it, with liquidity stats and
   * market status. Enabling is automatic: 24h volume >= minMarketDayVolumeUsd enables a pair, below disables it.
   * Exchange errors are not fatal: the runner keeps the known markets.
   */
  async refreshMarkets(): Promise<boolean> {
    const store = this.d.store as RunnerStore & Partial<MarketSyncTarget>;
    if (!store.upsertMarkets) return false;
    try {
      const rows = parseSpotUsdgMarkets(await this.d.exchange.spotMarkets());
      if (rows.length === 0) throw new Error("orderBookDetails has no USDG spot pairs");
      store.upsertMarkets(rows, this.now(), this.cfg.liquidity.minMarketDayVolumeUsd);
      return true;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "Lighter markets unavailable, using known markets");
      return false;
    }
  }

  private async isPremium(owner: Hex): Promise<boolean> {
    try {
      if (this.d.isPremium) return await this.d.isPremium(owner);
      const { hub } = this.d;
      if (!hub.enabled) return false;
      return await this.cache.get(`hub:premium:${lc(owner)}`, 60_000, () => hub.isPremium(owner));
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "isPremium: read failed, assuming false");
      return false;
    }
  }

  private async onchainActive(agent: AgentRecord): Promise<string | null> {
    const { hub } = this.d;
    if (!hub.enabled) return "chain_unavailable";
    const a = await this.cache.get<OnchainAgent | null>(`runner:agent:${agent.id}`, 60_000, () => hub.getAgent(agent.id));
    if (!a) return "not_onchain";
    if (a.status !== agent.chainStatus) this.d.store.setAgentChainStatus(agent.id, a.status);
    if (a.status !== 0) return a.status === 1 ? "paused_onchain" : "stopped_onchain";
    if (lc(a.apiWallet) !== lc(agent.apiWallet)) return "api_wallet_mismatch";
    return null;
  }

  /**
   * The agent key must be registered on the Lighter account (blocking). A missing or expired integrator approval does
   * NOT stop the agent: it trades without the platform fee (feeMode zero_fee_no_approval) and the owner is asked to
   * approve again.
   */
  private async approvalsOk(agent: AgentRecord): Promise<string | null> {
    const hit = this.approvals.get(agent.id);
    const t = Date.now();
    if (hit && hit.exp > t) return hit.ok ? null : `exchange_approvals:${hit.problems.join(",")}`;
    const st = await checkLighterApprovals(this.d.exchange, this.d.keyRows, agent.hlAccount, agent.apiWallet, this.integrator, this.now());
    const problems = st.problems.filter((p) => p !== "lighter_integrator_not_approved");
    this.approvals.set(agent.id, { ok: problems.length === 0, problems, integrator: st.integrator, exp: t + (problems.length ? 60_000 : 10 * 60_000) });
    return problems.length ? `exchange_approvals:${problems.join(",")}` : null;
  }

  /** Account tier (standard / plus / premium) via an auth token of the agent key; cached 10 min. */
  private async tierOf(agent: AgentRecord, key: AgentKeyRef): Promise<string | null> {
    const hit = this.tiers.get(agent.id);
    if (hit && hit.exp > Date.now()) return hit.tier;
    let tier: string | null = null;
    try {
      tier = await this.d.exchange.accountTier(key);
    } catch {
      tier = null;
    }
    this.tiers.set(agent.id, { tier, exp: Date.now() + (tier ? 10 * 60_000 : 60_000) });
    return tier;
  }

  private async fetchCandles(coin: string, tf: keyof typeof TIMEFRAME_MS, start: number): Promise<Candle[]> {
    const key = `${coin}:${tf}:${Math.floor(start / TIMEFRAME_MS[tf])}`;
    const ttl = Math.min(TIMEFRAME_MS[tf] / 4, 5 * 60_000);
    const hit = this.candleCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.candles;
    const candles = await this.d.exchange.candles(coin, tf, start);
    if (this.candleCache.size > 500) this.candleCache.clear();
    this.candleCache.set(key, { at: Date.now(), candles });
    return candles;
  }

  /** Premium model rules: a premium model without premium status falls back to the first enabled standard model. */
  effectiveModel(modelId: string, premium: boolean): ModelInfo | undefined {
    const all = this.d.store.listModels();
    const m = all.find((x) => x.id === modelId);
    if (m?.enabled && (m.tier === "standard" || premium)) return m;
    return all.find((x) => x.enabled && x.tier === "standard") ?? m;
  }

  async snapshot(agent: AgentRecord, spec: StrategySpec): Promise<Snapshot> {
    const { store, exchange } = this.d;
    const [allMids, raw] = await Promise.all([this.midsBySymbol(), exchange.spotBalances(agent.hlAccount)]);
    const mids: Record<string, number> = { ...allMids }; // copy: held positions get the book mid below
    const bal = new Map<string, SpotBalance>(raw.map((b) => [b.coin, b]));
    const usdcB = bal.get(QUOTE); // USDG: the ledger keeps the quote in its `usdc` field
    const realFree: Record<string, number> = {};
    for (const b of raw) if (b.coin !== QUOTE) realFree[b.coin] = Math.max(0, b.total - b.hold);
    // The agent's sub-account: its own USDG (allocation +/- own trades) and own tokens, reconciled with the real balance;
    // Protect (manageExistingHoldings) also gets tokens no running agent owns.
    const capital = computeAgentCapital(store, agent, { usdc: usdcB ? Math.max(0, usdcB.total - usdcB.hold) : 0, tokens: realFree });
    const balances = { usdc: capital.ok ? capital.usdc : 0, tokens: {} as Record<string, number> };
    // The agent's free tokens are its held positions; the market set is its pairs (or the "*" shortlist) plus positions.
    // Disabled or illiquid markets stay in the set while a position exists: sells and protective stops always work.
    const free: Record<string, number> = capital.ok ? { ...capital.tokens } : {};
    // Max spend per buy: min(free USDG, equity * min(maxTradeBps, preset budget)). Pairs where that amount, rounded down
    // to the lot step, is below the minimum order are not offered to the AI for buying.
    const roughEquity = balances.usdc + Object.entries(free).reduce((s, [sym, q]) => s + q * (mids[sym] ?? 0), 0);
    const preset = store.getPresetById(agent.presetId);
    const budgetBps = preset?.rules?.maxBuyBpsParam ? Number(spec.params?.[preset.rules.maxBuyBpsParam]) : Number.NaN;
    const capBps = Math.min(spec.risk.maxTradeBps, budgetBps > 0 ? budgetBps : Number.POSITIVE_INFINITY);
    const maxBuyUsd = Math.min(balances.usdc, (roughEquity * capBps) / 10000);
    const minOrderUsd = this.cfg.limits.minOrderUsd;
    const canBuy = (m: { symbol: string; szDecimals: number }) => affordableBuy(m.szDecimals, mids[m.symbol], maxBuyUsd, minOrderUsd);
    const known = store.listMarkets();
    const nowMs = this.now() * 1000;
    const isOpen = (m: ResolvedMarket) => marketOpenState(m, nowMs).open;
    const markets = agentUniverse(spec.markets, known, heldSymbols(free, mids), this.cfg.runner.allModeShortlist, canBuy, isOpen);
    const trades = store.allTradesAsc(agent.id);
    const positions: Position[] = [];
    // Held positions are priced at the order book mid, not the last price: on thin pairs the last trade can be far from
    // the book (production finding: 142.94 vs a book around 136 created a false trailing peak and a premature sell).
    for (const m of markets) {
      const q = Math.max(0, free[m.symbol] ?? 0);
      if (!(q > 0) || !((mids[m.symbol] ?? 0) * q >= POSITION_DUST_USD)) continue;
      const book = await this.cache.get<OrderBook>(`runner:book:${m.coin}`, 10_000, () => exchange.l2Book(m.coin)).catch(() => null);
      const bid = book?.bids[0]?.px;
      const ask = book?.asks[0]?.px;
      if (bid && ask && ask >= bid) mids[m.symbol] = (bid + ask) / 2;
    }
    for (const m of markets) {
      const b = bal.get(m.symbol);
      const qty = Math.max(0, free[m.symbol] ?? 0);
      balances.tokens[m.symbol] = qty;
      const tracked = avgEntryFromTrades(trades, m.symbol);
      const exEntry = b && b.total > 0 && b.entryNtl > 0 ? b.entryNtl / b.total : null;
      positions.push({ market: m.symbol, qty, entryPx: tracked.avgPx ?? exEntry });
    }
    const equity = computeEquity(balances, mids);
    const unbuyable: Record<string, "min_order"> = {};
    if (isAllMarkets(spec.markets)) {
      const inSet = new Set(markets.map((m) => m.symbol));
      for (const m of known) if (m.enabled && m.resolved && !inSet.has(m.symbol) && !canBuy(m)) unbuyable[m.symbol] = "min_order";
    }
    return { markets, mids, balances, positions, equity, capital, unbuyable };
  }

  // ---------- one agent tick ----------

  async tickAgent(agent: AgentRecord): Promise<TickOutcome> {
    const { store } = this.d;
    const log = this.log;
    const now = this.now();
    const spec = agent.spec;
    if (!agent.activated || !spec) return { kind: "skipped", reason: "not_activated" };
    if (agent.offchainStatus !== "ok") return { kind: "skipped", reason: `offchain_${agent.offchainStatus}` };
    const chainProblem = await this.onchainActive(agent);
    if (chainProblem) return { kind: "skipped", reason: chainProblem };
    const apprProblem = await this.approvalsOk(agent);
    if (apprProblem) return { kind: "skipped", reason: apprProblem };
    const preset = store.getPresetById(agent.presetId);
    if (!preset) return { kind: "skipped", reason: "preset_missing" };

    const snap = await this.snapshot(agent, spec);
    if (snap.capital && !snap.capital.ok) {
      // several agents on one Lighter account and this one has no allocation: it must not trade the whole account
      store.setOffchainStatus(agent.id, "paused", `allocation_required: ${snap.capital.message}`.slice(0, 300));
      log.warn({ agentId: agent.id, reason: snap.capital.message }, "agent paused: capital allocation required");
      return { kind: "skipped", reason: "allocation_required" };
    }
    let adoptedDeltaUsd = 0; // value change of adopted tokens not caused by own trades (external capital in/out)
    if (snap.capital?.ok) {
      if (snap.capital.scaledDown.length)
        log.info({ agentId: agent.id, symbols: snap.capital.scaledDown }, "capital: ledger scaled down to the real Lighter balance");
      const adopted = snap.capital.adopted;
      const prevAdopted = store.getCapital(agent.id)?.adopted ?? {};
      const keys = Object.keys({ ...adopted, ...prevAdopted });
      const changed = keys.some((k) => Math.abs((adopted[k] ?? 0) - (prevAdopted[k] ?? 0)) > 1e-9);
      if (changed) {
        for (const k of keys) adoptedDeltaUsd += ((adopted[k] ?? 0) - (prevAdopted[k] ?? 0)) * (snap.mids[k] ?? 0);
        store.setAdopted(agent.id, adopted, now);
        if (Object.keys(adopted).length) log.info({ agentId: agent.id, adopted }, "capital: adopted holdings not owned by running agents");
      }
    }
    const state: AgentState = { ...agent.state };
    // The equity baselines (day start / initial) must be in the same capital accounting mode as the current equity,
    // otherwise switching from "whole account" to "agent sub-account" shows a false daily loss (production finding).
    const capitalMode = snap.capital?.ok ? snap.capital.mode : "whole_account";
    // A baseline set on THIS tick from snap.equity already includes adopted tokens and must not be shifted
    // (production finding: a new Protect agent got a $41.6 baseline for $20.4 guarded, a false daily_loss).
    let baselineFresh = !state.dayStart || state.dayStart.day !== utcDay(now) || state.initialEquity === undefined;
    if (state.capitalMode !== capitalMode && snap.equity > 0) {
      baselineFresh = true;
      if (state.capitalMode !== undefined || state.dayStart)
        log.info({ agentId: agent.id, from: state.capitalMode ?? "legacy", to: capitalMode }, "capital mode changed: equity baselines reset");
      state.capitalMode = capitalMode;
      state.dayStart = { day: utcDay(now), equity: snap.equity };
      state.initialEquity = snap.equity;
    }
    // Adopting/releasing tokens (not an own trade) moves capital, it is not PnL: shift the baselines by the same amount,
    // otherwise the watchdog sees a false daily loss. Right after an own sell (<= 60 s) no shift is applied.
    const ownTradeRecently = state.lastTradeAt !== undefined && now - state.lastTradeAt <= 60;
    if (Math.abs(adoptedDeltaUsd) > 0.01 && !ownTradeRecently && !baselineFresh) {
      if (state.dayStart) state.dayStart = { ...state.dayStart, equity: Math.max(0, state.dayStart.equity + adoptedDeltaUsd) };
      if (state.initialEquity !== undefined) state.initialEquity = Math.max(0, state.initialEquity + adoptedDeltaUsd);
    }
    if (state.initialEquity === undefined && snap.equity > 0) state.initialEquity = snap.equity;
    if (!state.dayStart || state.dayStart.day !== utcDay(now)) state.dayStart = { day: utcDay(now), equity: snap.equity };
    state.lastEquity = snap.equity;
    state.lastEquityAt = now;
    this.equity.record(agent.id, now, snap.equity); // equity series (<= 1 point per minute, right after a trade)
    state.peaks = updatePeaks(state.peaks ?? {}, snap.positions, snap.mids);
    const dailyPnlBps = state.dayStart.equity > 0 ? ((snap.equity - state.dayStart.equity) / state.dayStart.equity) * 10000 : 0;
    const tradesToday = store.countTradesSince(agent.id, dayStartSec(now));
    const riskBase: Omit<RiskInput, "decision"> = {
      spec,
      preset,
      params: spec.params,
      markets: snap.markets,
      balances: snap.balances,
      mids: snap.mids,
      tradesToday,
      dailyPnlBps,
      protectOnly: agent.protectOnly,
      startedAt: agent.activatedAt ?? agent.createdAt,
      nowSec: now,
      limits: this.cfg.limits,
      unbuyable: snap.unbuyable,
    };

    // 2) protective stops and preset exit rules (rules.exitWhen): no AI
    // dust (below the minimum order) cannot be sold: do not fire stops on it every tick (production finding)
    const minOrderUsd = this.cfg.limits.minOrderUsd;
    const sellable = snap.positions.filter((p) => p.qty * (snap.mids[p.market] ?? 0) >= minOrderUsd);
    const triggers: { market: string; reason: string; kind?: string }[] = checkProtection(preset, spec.params, sellable, snap.mids, state.peaks);
    const exitRule = preset.rules?.exitWhen;
    if (exitRule?.length) {
      const labels = indicatorLabels(preset.indicators, spec.params);
      const indSpecs = resolveIndicatorSpecs(preset.indicators, spec.params);
      for (const p of snap.positions) {
        if (!(p.qty > 0) || triggers.some((t) => t.market === p.market)) continue;
        const mid = snap.mids[p.market] ?? 0;
        if (!(p.qty * mid >= minOrderUsd)) continue;
        const m = snap.markets.find((x) => x.symbol === p.market);
        if (!m) continue;
        let byLabel: Record<string, number | null> = {};
        try {
          byLabel = await computeIndicators(indSpecs, m.coin, (coin, tf, start) => this.fetchCandles(coin, tf, start), now * 1000);
        } catch {
          continue; // no candles: the exit rule does not fire (stops still work)
        }
        if (evalConditions(exitRule, indicatorValues(labels, byLabel), mid, spec.params) === true)
          triggers.push({ market: p.market, kind: "exit_rule", reason: `Exit rule: ${describeConditions(exitRule, labels, spec.params)}` });
      }
    }
    if (triggers.length > 0) {
      const decision: AgentDecision = {
        actions: triggers.map((t) => ({ type: "sell", market: t.market, sizeBps: 10000, reason: t.reason })),
        note: "protective stops (executed by code)",
      };
      const pre = evaluateDecision({ ...riskBase, decision }, { protective: true });
      const liq = await this.liquidityPass(agent.id, pre.orders, decision, snap.markets, "clip");
      const risk = { ...pre, orders: liq.orders, rejections: [...pre.rejections, ...liq.rejections] };
      const filled = await this.execute(agent, risk.orders, "protect", state);
      store.insertDecision({ agentId: agent.id, ts: now, provider: "code", model: "protection", decision, rejections: risk.rejections });
      store.setAgentState(agent.id, state);
      log.info({ agentId: agent.id, triggers: triggers.map((t) => t.kind), filled }, "protective stops");
      return { kind: "protect", orders: risk.orders, filled, rejections: risk.rejections };
    }

    // 3) is a decision due?
    const premium = await this.isPremium(agent.owner);
    const min = this.d.minIntervalSec ?? 300;
    // the interval comes from the current spec (it can change off-chain by signature), not the on-chain column
    const baseInterval = spec.intervalSec || agent.intervalSec;
    const interval = premium ? baseInterval : Math.max(baseInterval, min);
    if (state.lastDecisionAt && now - state.lastDecisionAt < interval) {
      store.setAgentState(agent.id, state);
      return { kind: "not_due" };
    }
    // rebalancing (rules.rebalance): the code computes the plan; the AI is called only when the drift exceeds the band
    const codePlan = this.rebalanceActions(preset, spec, snap, state, now);
    const trigger = preset.rules?.rebalance ? codePlan.length > 0 : this.cheapTrigger(preset, spec, snap, state, now);
    if (!trigger) {
      store.setAgentState(agent.id, state);
      return { kind: "no_trigger" };
    }

    // context -> AI
    // protectOnly only ever comes from a failed AI call, and that call already held its own tick: the next decision
    // is asked with normal permissions (carrying the flag forward made the AI hold for several checks in a row)
    const ctx = await this.buildContext(preset, spec, snap, state, dailyPnlBps, tradesToday, false, now);
    if (codePlan.length) ctx.codePlan = codePlan;
    const model = this.effectiveModel(spec.model, premium);
    const res = await this.d.llm.decide(agent.id, model, ctx);
    const protectOnly = !res.ok;
    if (protectOnly !== agent.protectOnly) store.setProtectOnly(agent.id, protectOnly);
    state.lastLlmError = res.ok ? undefined : res.errors.join(" | ").slice(0, 500);

    const labels = indicatorLabels(preset.indicators, spec.params);
    const indicators = Object.fromEntries(ctx.markets.map((m) => [m.symbol, indicatorValues(labels, m.indicators)]));
    const lastBuy = store
      .allTradesAsc(agent.id)
      .filter((t) => t.side === "buy")
      .pop();
    const pre = evaluateDecision({ ...riskBase, protectOnly, decision: res.value, indicators, secondsSinceLastBuy: lastBuy ? now - lastBuy.timestamp : null });
    const liq = await this.liquidityPass(agent.id, pre.orders, res.value, snap.markets, "strict");
    const risk = { ...pre, orders: liq.orders, rejections: [...pre.rejections, ...liq.rejections] };
    for (const r of risk.rejections)
      log.info({ agentId: agent.id, code: r.code, market: r.action?.market, type: r.action?.type }, `risk engine: rejected: ${r.message}`);
    const filled = await this.execute(agent, risk.orders, "llm", state);
    // a failed AI call says why in the feed ("AI unavailable: timeout"); a backup model says which model it replaced
    const stored = !res.ok ? { ...res.value, note: aiUnavailableNote(res.errors) } : res.fallback ? { ...res.value, fallback: res.fallback } : res.value;
    store.insertDecision({ agentId: agent.id, ts: now, provider: res.provider, model: res.model, decision: stored, rejections: risk.rejections });
    state.lastDecisionAt = now;
    state.lastDecisionMids = Object.fromEntries(snap.markets.filter((m) => (snap.mids[m.symbol] ?? 0) > 0).map((m) => [m.symbol, snap.mids[m.symbol]!]));
    store.setAgentState(agent.id, state);
    return { kind: "decided", ok: res.ok, decision: res.value, orders: risk.orders, filled, rejections: risk.rejections, provider: res.provider };
  }

  /** Rebalance plan (rules.rebalance) as actions for the AI; empty when there is no drift or it is too early (minIntervalParam). */
  rebalanceActions(preset: PresetInfo, spec: StrategySpec, snap: Snapshot, state: AgentState, now: number): AgentAction[] {
    const rb = preset.rules?.rebalance;
    if (!rb) return [];
    const minGap = numParam(spec.params, rb.minIntervalParam) ?? 0;
    if (minGap > 0 && state.lastTradeAt && now - state.lastTradeAt < minGap) return [];
    const known = new Map(snap.markets.map((m) => [m.symbol, m]));
    return rebalancePlan({
      targets: weightsParam(spec.params, rb.targetsParam) ?? {},
      bandBps: numParam(spec.params, rb.bandParam) ?? 300,
      equity: snap.equity,
      balances: snap.balances,
      mids: snap.mids,
      buyable: (s) => !!known.get(s) && known.get(s)?.buyable !== false,
    }).map((p) => ({
      type: p.type,
      market: p.market,
      sizeBps: p.sizeBps,
      reason: `Rebalance: ${p.market} is ${p.currentBps} bps of equity vs target ${p.targetBps} bps`,
    }));
  }

  /**
   * Cheap trigger without AI: first decision; a price move >= triggerMovePct since the last decision; a position near a
   * stop/take level; a scheduled time (any numeric preset param named *EverySec, e.g. buyEverySec); or the heartbeat.
   */
  cheapTrigger(preset: PresetInfo, spec: StrategySpec, snap: Snapshot, state: AgentState, now: number): boolean {
    const cfg = this.cfg.runner;
    if (!state.lastDecisionAt || !state.lastDecisionMids) return true;
    if (now - state.lastDecisionAt >= cfg.heartbeatSec) return true;
    for (const { symbol: m } of snap.markets) {
      const prev = state.lastDecisionMids[m] ?? 0;
      const cur = snap.mids[m] ?? 0;
      if (prev > 0 && cur > 0 && (Math.abs(cur - prev) / prev) * 100 >= cfg.triggerMovePct) return true;
    }
    if (nearProtection(preset, spec.params, snap.positions, snap.mids, state.peaks ?? {})) return true;
    for (const [k, v] of Object.entries(spec.params)) {
      if (k.endsWith("EverySec") && typeof v === "number" && v > 0 && now - (state.lastTradeAt ?? 0) >= v) return true;
    }
    return false;
  }

  async buildContext(
    preset: PresetInfo,
    spec: StrategySpec,
    snap: Snapshot,
    state: AgentState,
    dailyPnlBps: number,
    tradesToday: number,
    protectOnly: boolean,
    now: number,
  ): Promise<DecisionContext> {
    const indSpecs = resolveIndicatorSpecs(preset.indicators, spec.params);
    const minOrderUsd = this.cfg.limits.minOrderUsd;
    const markets: MarketContext[] = [];
    for (const m of snap.markets) {
      const open = marketOpenState(m, now * 1000);
      const mid = snap.mids[m.symbol] ?? 0;
      let indicators: Record<string, number | null> = {};
      try {
        indicators = await computeIndicators(indSpecs, m.coin, (coin, tf, start) => this.fetchCandles(coin, tf, start), now * 1000);
      } catch (e) {
        this.log.warn({ market: m.symbol, err: (e as Error).message }, "candles unavailable");
      }
      const pos = snap.positions.find((p) => p.market === m.symbol);
      const prev = state.lastDecisionMids?.[m.symbol];
      // Minimum sell as a share of the position (no absolute amounts in the prompt), accounting for the lot step and a
      // fill below mid. Production finding: the AI picked exactly the minimum share and the rounded order was $9.88 < $10.
      const posUsd = pos && pos.qty > 0 ? pos.qty * mid : 0;
      const minSell = posUsd > 0 && pos ? minSellShareBps(pos.qty, mid, m.szDecimals, minOrderUsd) : null;
      markets.push({
        symbol: m.symbol,
        midUsd: mid,
        changeSinceLastDecisionPct: prev && prev > 0 && mid > 0 ? ((mid - prev) / prev) * 100 : null,
        indicators,
        positionBps: snap.equity > 0 && pos ? ((pos.qty * mid) / snap.equity) * 10000 : 0,
        unrealizedPnlPct: pos && pos.qty > 0 && pos.entryPx ? ((mid - pos.entryPx) / pos.entryPx) * 100 : null,
        buyable: m.buyable,
        minSellShareBps: minSell !== null && minSell <= 10000 ? minSell : null,
        ...(open.open ? {} : { closed: true, closedReason: open.reason }),
      });
    }
    // MIN_ORDER_MARGIN headroom for lot rounding and the fill price (for buys the lot step is already handled by `buyable`)
    const minOrderBps = snap.equity > 0 ? Math.ceil(((minOrderUsd * MIN_ORDER_MARGIN) / snap.equity) * 10000) : null;
    return {
      minOrderShareBps: minOrderBps,
      preset,
      goal: spec.goal,
      risk: spec.risk,
      params: spec.params,
      markets,
      usdcBps: snap.equity > 0 ? (snap.balances.usdc / snap.equity) * 10000 : 0,
      dailyPnlBps,
      tradesToday,
      protectOnly,
      secondsSinceLastTrade: state.lastTradeAt ? now - state.lastTradeAt : null,
      nowIso: new Date(now * 1000).toISOString(),
    };
  }

  /**
   * Liquidity guard for EVERY order: the l2Book at execution time -> checkLiquidity.
   * strict (AI orders): reject on spread / volume / depth / impact. clip (protective stops): the size is clipped to what
   * fills within the slippage band; an exit is never blocked by spread or volume.
   */
  async liquidityPass(
    agentId: number,
    orders: ApprovedOrder[],
    decision: AgentDecision,
    markets: ResolvedMarket[],
    mode: "strict" | "clip",
  ): Promise<{ orders: ApprovedOrder[]; rejections: Rejection[] }> {
    const { exchange } = this.d;
    const cfg = this.cfg;
    const out: ApprovedOrder[] = [];
    const rejections: Rejection[] = [];
    const books = new Map<string, OrderBook | null>();
    const limits = {
      maxSpreadBps: cfg.liquidity.maxSpreadBps,
      maxSlippageBps: cfg.limits.maxSlippageBps,
      maxOrderPctOfDayVolume: cfg.liquidity.maxOrderPctOfDayVolume,
      minMarketDayVolumeUsd: cfg.liquidity.minMarketDayVolumeUsd,
      minOrderUsd: cfg.limits.minOrderUsd,
      bookBufferBps: cfg.liquidity.bookBufferBps,
    };
    for (const o of orders) {
      const action = decision.actions?.[o.index] ?? { type: o.side, market: o.market, sizeBps: 0, reason: o.reason };
      if (!books.has(o.coin)) books.set(o.coin, await exchange.l2Book(o.coin).catch(() => null));
      const book = books.get(o.coin);
      if (!book) {
        rejections.push({ index: o.index, action, code: "no_book", message: `order book for ${o.market} is unavailable` });
        continue;
      }
      const mkt = markets.find((m) => m.symbol === o.market);
      const szDecimals = mkt?.szDecimals ?? 0;
      // a sell is an exit: always the soft mode (never blocked by spread/volume, clipped to what fills)
      const orderMode = o.side === "sell" ? "clip" : mode;
      const r = checkLiquidity(
        { side: o.side, sizeBase: Number(o.sizeBase), limitPx: Number(o.limitPx), szDecimals, priceDecimals: o.priceDecimals },
        book,
        mkt?.dayVolumeUsd ?? 0,
        limits,
        orderMode,
      );
      if (!r.ok) {
        rejections.push({ index: o.index, action, code: r.code, message: r.message });
        this.log.info(
          { agentId, market: o.market, side: o.side, code: r.code, spreadBps: r.spreadBps, impactBps: r.impactBps },
          `liquidity guard: rejected: ${r.message}`,
        );
        continue;
      }
      if (r.clipped)
        this.log.warn({ agentId, market: o.market, from: o.sizeBase, to: r.sizeBase }, "liquidity guard: protective order clipped to fillable size");
      out.push({ ...o, sizeBase: r.sizeBase, limitPx: r.limitPx, notionalUsd: r.notionalUsd });
    }
    return { orders: out, rejections };
  }

  /**
   * Executes approved orders signed by the agent's Lighter API key. Partner attribution (the platform's integrator
   * account) is attached only with a valid ApproveIntegrator; a non-zero fee only on Plus/Premium (Lighter forbids
   * partner fees on Standard). Lighter charges spot fees in the RECEIVED asset (buy: the token, sell: USDG) on both
   * sides; the ledger records the net token amount of a buy. Returns the number of filled orders.
   */
  async execute(agent: AgentRecord, orders: ApprovedOrder[], source: "llm" | "protect", state: AgentState): Promise<number> {
    if (orders.length === 0) return 0;
    const { store, exchange } = this.d;
    const log = this.log;
    if (this.cfg.runner.dryRun) {
      for (const o of orders) log.info({ agentId: agent.id, ...o }, "DRY_RUN: order not sent");
      return 0;
    }
    let key: AgentKeyRef;
    try {
      key = await this.d.keys.agentKey(agent);
    } catch (e) {
      log.error({ agentId: agent.id, err: (e as Error).message }, "agent Lighter key unavailable: cannot execute orders");
      return 0;
    }
    const approval = this.approvals.get(agent.id)?.integrator ?? { approved: false, maxSpotTakerFee: 0, maxSpotMakerFee: 0, expiresAt: null };
    const valid = approval.approved && (approval.expiresAt ?? 0) > this.now() * 1000 + 60_000;
    const ig = integratorForOrder(this.integrator, { ...approval, approved: valid }, valid ? await this.tierOf(agent, key) : null);
    if (ig.feeMode !== state.feeMode) {
      state.feeMode = ig.feeMode;
      log.info({ agentId: agent.id, feeMode: ig.feeMode }, "platform fee mode");
    }
    let filled = 0;
    for (const o of orders) {
      const res = await exchange.placeOrder(key, {
        marketId: o.marketId,
        coin: o.coin,
        isBuy: o.side === "buy",
        price: o.limitPx,
        size: o.sizeBase,
        szDecimals: o.szDecimals,
        priceDecimals: o.priceDecimals,
        tif: o.tif,
        ...(ig.fields ? { integrator: ig.fields } : {}),
      });
      const filledSz = res.filledSz ?? 0;
      if (res.status !== "filled" || !(filledSz > 0)) {
        log.warn({ agentId: agent.id, market: o.market, side: o.side, status: res.status, error: res.error }, "order not filled");
        continue;
      }
      const px = res.avgPx ?? Number(o.limitPx);
      const sizeUsd = filledSz * px;
      // buy: fees are taken in the bought token, so the ledger records the net amount; otherwise the agent's
      // sub-account would "see" tokens that are not there (dust and needless reconciliations)
      let sizeBase = filledSz;
      if (o.side === "buy" && res.netBaseReceived !== undefined && res.netBaseReceived > 0 && res.netBaseReceived <= sizeBase) sizeBase = res.netBaseReceived;
      const feeRate = ig.fields?.takerFee ?? 0;
      store.insertTrade({
        agentId: agent.id,
        owner: agent.owner,
        side: o.side,
        market: o.market,
        sizeUsd,
        sizeBase,
        price: px,
        reason: o.reason,
        hlOrderId: res.oid ?? 0,
        timestamp: this.now(),
        platformFeeUsd: (sizeUsd * feeRate) / 1_000_000,
        source,
        exchangeOrderId: res.orderIndex ?? null,
        exchangeTxHash: res.txHash ?? null,
      });
      state.lastTradeAt = this.now();
      this.equity.markDirty(agent.id);
      filled++;
      log.info({ agentId: agent.id, market: o.market, side: o.side, sz: filledSz, px, source }, "trade filled");
    }
    return filled;
  }

  // ---------- receipts ----------

  /** Writes unrecorded trades to the receipt sink (one TradeRecorded event per trade). */
  async flushTrades(): Promise<number> {
    const { receipts, store } = this.d;
    if (!receipts?.enabled) return 0;
    let total = 0;
    for (const trades of batches(store.unrecordedTrades(100), 100)) {
      try {
        const tx = await receipts.recordTrades(trades.map(toTradeReceipt));
        store.markTradesRecorded(
          trades.map((t) => t.id),
          tx,
        );
        this.log.info({ count: trades.length, tx }, "recordTrades");
        total += trades.length;
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, "recordTrades failed, will retry");
      }
    }
    return total;
  }

  /** Snapshots an epoch (equity, PnL) for agents due after epochSec and writes them in a batch as EpochRecorded receipts. */
  async recordEpochs(): Promise<number> {
    const { store, receipts } = this.d;
    const now = this.now();
    for (const a of store.listRunnableAgents()) {
      const s = a.state;
      if (s.lastEquity === undefined || !s.initialEquity) continue;
      if (s.lastEpochAt && now - s.lastEpochAt < this.cfg.runner.epochSec) continue;
      const r = toEpochReceipt({ agentId: a.id, equityUsd: s.lastEquity, initialEquityUsd: s.initialEquity, timestamp: now });
      store.insertEpoch(a.id, s.lastEquity, r.pnlBps, now);
      store.setAgentState(a.id, { ...s, lastEpochAt: now });
    }
    if (!receipts?.enabled) return 0;
    const epochs = store.unrecordedEpochs(100);
    if (epochs.length === 0) return 0;
    try {
      const tx = await receipts.recordEpochs(
        epochs.map((e) => ({ agentId: BigInt(e.agentId), equityUsd: BigInt(Math.round(e.equityUsd * 1e6)), pnlBps: e.pnlBps, timestamp: BigInt(e.ts) })),
      );
      store.markEpochsRecorded(
        epochs.map((e) => e.id),
        tx,
      );
      this.log.info({ count: epochs.length, tx }, "recordEpochs");
      return epochs.length;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "recordEpochs failed, will retry");
      return 0;
    }
  }

  async tickAll(): Promise<void> {
    if (this.busy) return; // the previous tick is still running
    this.busy = true;
    try {
      for (const agent of this.d.store.listRunnableAgents()) {
        try {
          const out = await this.tickAgent(agent);
          if (out.kind === "skipped") this.log.debug({ agentId: agent.id, reason: out.reason }, "agent skipped");
        } catch (e) {
          this.log.error({ agentId: agent.id, err: (e as Error).message }, "agent tick failed");
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    const { runner, liquidity } = this.cfg;
    void this.refreshMarkets();
    this.timers.push(setInterval(() => void this.tickAll(), runner.tickSec * 1000));
    this.timers.push(setInterval(() => void this.flushTrades(), runner.receiptsFlushSec * 1000));
    this.timers.push(setInterval(() => void this.recordEpochs(), Math.min(runner.epochSec, 600) * 1000));
    this.timers.push(setInterval(() => void this.refreshMarkets(), liquidity.marketsSyncSec * 1000));
    void this.tickAll();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
