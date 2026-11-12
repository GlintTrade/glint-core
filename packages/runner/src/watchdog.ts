// Watchdog: an independent check of the limits, separate from the runner. It reads balances through the public
// Lighter account API and today's fills through the trades endpoint (with an auth token of the agent key: read only).
// On a violation it pauses the agent off-chain (the runner honours the pause) and alerts.
import { type ExchangeClient, type ExchangeFill, QUOTE } from "@glint/lighter";
import { isAllMarkets, type RiskBox } from "@glint/strategy";
import { TtlCache } from "./cache.js";
import { agentsOnAccount, computeAgentCapital } from "./capital/service.js";
import type { RunnerConfig } from "./config.js";
import type { KeyVault } from "./keys.js";
import { type Logger, noopLogger } from "./log.js";
import { midsBySymbol, type RunnerStore } from "./store.js";
import type { AgentRecord } from "./types.js";

/**
 * Fills that belong to the agent: on a shared Lighter account, orders recorded by OTHER agents are excluded (by oid =
 * our client_order_index). An order attributed to the platform that no agent recorded stays with everyone: that is
 * suspicious (production finding: a sell by agent #3 paused Trend agent #5 as a "trade outside its markets").
 */
export function fillsOfAgent<T extends { oid: number }>(fills: T[], otherAgentsOids: Set<number>): T[] {
  return fills.filter((f) => !otherAgentsOids.has(f.oid));
}

export interface WatchdogInput {
  risk: RiskBox;
  markets: { symbol: string; coin: string; enabled?: boolean; dayVolumeUsd?: number }[]; // the agent's markets
  balances: { usdc: number; tokens: Record<string, number> };
  mids: Record<string, number>;
  dayStartEquity: number | null;
  llmTradesToday: number; // AI trades recorded today (protective stops do not count)
  /** Today's fills of the account attributed to the platform; builderFee defined = attributed (integrator account or our oid). */
  builderFillsToday: ExchangeFill[];
  tolerance: { positionBps: number; lossBps: number };
  /** 24h volume threshold: buys in markets below it are a violation (optional). */
  minMarketDayVolumeUsd?: number;
  /** "*" mode: max distinct tokens held at once (optional). */
  maxDistinctPositions?: number;
}

export interface Violation {
  code: "position_limit" | "daily_loss" | "trades_per_day" | "non_whitelisted_trade" | "illiquid_market_trade" | "too_many_positions";
  message: string;
}

export function evaluateWatchdog(i: WatchdogInput): Violation[] {
  const out: Violation[] = [];
  let equity = Math.max(0, i.balances.usdc);
  for (const m of i.markets) equity += (i.balances.tokens[m.symbol] ?? 0) * (i.mids[m.symbol] ?? 0);
  if (equity > 0) {
    for (const m of i.markets) {
      const bps = (((i.balances.tokens[m.symbol] ?? 0) * (i.mids[m.symbol] ?? 0)) / equity) * 10000;
      if (bps > i.risk.maxPositionBps + i.tolerance.positionBps)
        out.push({
          code: "position_limit",
          message: `${m.symbol}: share ${Math.round(bps)} bps > ${i.risk.maxPositionBps} (+${i.tolerance.positionBps} tolerance)`,
        });
    }
  }
  if (i.maxDistinctPositions !== undefined) {
    const held = i.markets.filter((m) => (i.balances.tokens[m.symbol] ?? 0) * (i.mids[m.symbol] ?? 0) >= 1).length;
    if (held > i.maxDistinctPositions) out.push({ code: "too_many_positions", message: `holding ${held} distinct tokens > limit ${i.maxDistinctPositions}` });
  }
  if (i.dayStartEquity && i.dayStartEquity > 0) {
    const lossBps = ((i.dayStartEquity - equity) / i.dayStartEquity) * 10000;
    if (lossBps > i.risk.maxDailyLossBps + i.tolerance.lossBps)
      out.push({ code: "daily_loss", message: `daily loss ${Math.round(lossBps)} bps > ${i.risk.maxDailyLossBps} (+${i.tolerance.lossBps} tolerance)` });
  }
  if (i.llmTradesToday > i.risk.maxTradesPerDay)
    out.push({ code: "trades_per_day", message: `AI trades today ${i.llmTradesToday} > ${i.risk.maxTradesPerDay}` });
  const coins = new Set(i.markets.map((m) => m.coin));
  const foreign = i.builderFillsToday.filter((f) => f.builderFee !== undefined && !coins.has(f.coin));
  if (foreign.length > 0)
    out.push({ code: "non_whitelisted_trade", message: `trades outside the agent's markets: ${[...new Set(foreign.map((f) => f.coin))].join(", ")}` });
  // buys (not sells: exiting a position is always allowed) in disabled or illiquid markets
  const byCoin = new Map(i.markets.map((m) => [m.coin, m]));
  const badBuys = i.builderFillsToday.filter((f) => {
    if (f.builderFee === undefined || f.side !== "B") return false;
    const m = byCoin.get(f.coin);
    if (!m) return false;
    if (m.enabled === false) return true;
    return i.minMarketDayVolumeUsd !== undefined && m.dayVolumeUsd !== undefined && m.dayVolumeUsd < i.minMarketDayVolumeUsd;
  });
  if (badBuys.length > 0)
    out.push({
      code: "illiquid_market_trade",
      message: `buys in disabled or illiquid markets: ${[...new Set(badBuys.map((f) => byCoin.get(f.coin)?.symbol ?? f.coin))].join(", ")}`,
    });
  const oids = new Set(i.builderFillsToday.filter((f) => f.builderFee !== undefined && coins.has(f.coin)).map((f) => f.oid));
  // + headroom for protective stops (one per market)
  if (oids.size > i.risk.maxTradesPerDay + i.markets.length)
    out.push({ code: "trades_per_day", message: `exchange orders today ${oids.size} > ${i.risk.maxTradesPerDay}` });
  return out;
}

export interface Alerter {
  send(text: string): Promise<void>;
}

/** Writes alerts to the log. Plug in any channel (chat, e-mail, pager) by implementing Alerter. */
export class LogAlerter implements Alerter {
  constructor(private readonly log: Logger = noopLogger) {}
  async send(text: string): Promise<void> {
    this.log.warn({ alert: text }, "ALERT");
  }
}

export interface WatchdogDeps {
  store: RunnerStore;
  exchange: ExchangeClient;
  /** Agent keys, for reading today's fills with an auth token (read only). Without it fills are not checked. */
  keys?: KeyVault;
  config: RunnerConfig;
  log?: Logger;
  now?: () => number;
  alerter?: Alerter;
}

export class Watchdog {
  private timer?: NodeJS.Timeout;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly alerter: Alerter;
  private readonly cache = new TtlCache();

  constructor(private readonly d: WatchdogDeps) {
    this.log = d.log ?? noopLogger;
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.alerter = d.alerter ?? new LogAlerter(this.log);
  }

  async checkAgent(agent: AgentRecord): Promise<Violation[]> {
    const { store, exchange, config } = this.d;
    const spec = agent.spec;
    if (!spec) return [];
    const now = this.now();
    const dayStart = Math.floor(now / 86400) * 86400;
    const allMode = isAllMarkets(spec.markets);
    // "*" mode: the agent's markets are all known pairs (buys on disabled/illiquid ones are still caught by illiquid_market_trade)
    const known = store.listMarkets();
    const markets = known.filter((m) => m.resolved && (allMode || spec.markets.includes(m.symbol)));
    const key = this.d.keys ? await this.d.keys.agentKey(agent).catch(() => null) : null;
    const [raw, allMids, fills] = await Promise.all([
      exchange.spotBalances(agent.hlAccount),
      exchange.allMids(),
      key
        ? this.cache.get(`watchdog:fills:${agent.id}`, 60_000, () => exchange.fillsSince(key, dayStart * 1000)).catch(() => [] as ExchangeFill[])
        : Promise.resolve([] as ExchangeFill[]),
    ]);
    const mids = midsBySymbol(allMids, known);
    const real = { usdc: 0, tokens: {} as Record<string, number> };
    for (const b of raw) {
      if (b.coin === QUOTE) real.usdc = b.total;
      else real.tokens[b.coin] = b.total;
    }
    // the platform's fills: attributed to our integrator account, or an oid one of our agents recorded
    const ourOids = new Set(
      agentsOnAccount(store, agent.hlAccount)
        .concat([agent])
        .flatMap((a) => store.allTradesAsc(a.id).map((t) => t.hlOrderId)),
    );
    const platformFills = fills
      .filter((f) => f.time >= dayStart * 1000)
      .map((f) => (f.builderFee === undefined && f.oid > 0 && ourOids.has(f.oid) ? { ...f, builderFee: 0 } : f));
    // limits are checked against the agent's sub-account (several agents may share one Lighter account)
    const cap = computeAgentCapital(store, agent, real);
    if (!cap.ok) return []; // an agent without capital on a shared account is paused by the runner
    const balances = { usdc: cap.usdc, tokens: { ...cap.tokens } };
    const today = new Date(now * 1000).toISOString().slice(0, 10);
    const llmTradesToday = store.allTradesAsc(agent.id).filter((t) => t.timestamp >= dayStart && t.source === "llm").length;
    return evaluateWatchdog({
      risk: agent.risk.maxTradesPerDay ? agent.risk : spec.risk,
      markets,
      balances,
      mids,
      // The day baseline is valid only when recorded in the current capital accounting mode (the runner sets capitalMode);
      // for agents from an older mode the daily loss check waits for the first runner tick.
      dayStartEquity: agent.state.dayStart?.day === today && agent.state.capitalMode !== undefined ? agent.state.dayStart.equity : null,
      llmTradesToday,
      builderFillsToday: fillsOfAgent(
        platformFills.filter((f) => f.coin.includes("/")), // spot pairs only
        new Set(agentsOnAccount(store, agent.hlAccount, agent.id).flatMap((a) => store.allTradesAsc(a.id).map((t) => t.hlOrderId))),
      ),
      tolerance: { positionBps: config.watchdog.positionToleranceBps, lossBps: config.watchdog.lossToleranceBps },
      minMarketDayVolumeUsd: config.liquidity.minMarketDayVolumeUsd,
      ...(allMode ? { maxDistinctPositions: config.limits.maxDistinctPositions } : {}),
    });
  }

  /** Checks every runnable agent; returns how many were paused. */
  async checkAll(): Promise<number> {
    let paused = 0;
    for (const agent of this.d.store.listRunnableAgents()) {
      try {
        const v = await this.checkAgent(agent);
        if (v.length === 0) continue;
        const reason = v.map((x) => x.code).join(",");
        this.d.store.setOffchainStatus(agent.id, "paused", `watchdog:${reason}`);
        paused++;
        const lines = v.map((x) => `- ${x.message}`).join("\n");
        await this.alerter.send(`[glint watchdog] Agent #${agent.id} was paused by the watchdog:\n${lines}`);
      } catch (e) {
        this.log.warn({ agentId: agent.id, err: (e as Error).message }, "watchdog: check failed");
      }
    }
    return paused;
  }

  start(): void {
    const loop = async () => {
      await this.checkAll();
      this.timer = setTimeout(loop, this.d.config.watchdog.intervalSec * 1000);
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
