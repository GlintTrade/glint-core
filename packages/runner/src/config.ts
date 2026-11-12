// Runner configuration. Every value has a safe, documented default; loadRunnerConfig reads overrides from env.
import { LIGHTER_MAX_SPOT_FEE } from "@glint/lighter";
import { LIMITS } from "@glint/strategy";
import type { IntegratorConfig } from "./approvals.js";

export interface RunnerConfig {
  runner: {
    tickSec: number; // how often every agent is checked (protective stops run on every tick)
    receiptsFlushSec: number; // how often filled trades are written as TradeRecorded receipts
    epochSec: number; // equity snapshot period (EpochRecorded receipts)
    triggerMovePct: number; // price move since the last decision that wakes the AI early
    heartbeatSec: number; // the AI re-evaluates at least this often
    dryRun: boolean; // log approved orders instead of sending them
    allModeShortlist: number; // candidates shown to the AI in "all liquid pairs" mode
  };
  limits: { maxSlippageBps: number; minOrderUsd: number; maxDistinctPositions: number };
  liquidity: {
    maxSpreadBps: number;
    maxOrderPctOfDayVolume: number;
    minMarketDayVolumeUsd: number;
    liquidDayVolumeUsd: number;
    bookBufferBps: number;
    marketsSyncSec: number;
  };
  watchdog: { intervalSec: number; positionToleranceBps: number; lossToleranceBps: number };
}

export const DEFAULT_CONFIG: RunnerConfig = {
  runner: { tickSec: 15, receiptsFlushSec: 30, epochSec: 3600, triggerMovePct: 0.3, heartbeatSec: 3600, dryRun: false, allModeShortlist: 12 },
  limits: { maxSlippageBps: LIMITS.maxSlippageBps, minOrderUsd: LIMITS.minOrderUsd, maxDistinctPositions: 8 },
  liquidity: { maxSpreadBps: 150, maxOrderPctOfDayVolume: 2, minMarketDayVolumeUsd: 5000, liquidDayVolumeUsd: 100_000, bookBufferBps: 10, marketsSyncSec: 600 },
  watchdog: { intervalSec: 30, positionToleranceBps: 1000, lossToleranceBps: 500 },
};

type Env = Record<string, string | undefined>;

const num = (env: Env, key: string, def: number): number => {
  const s = env[key];
  if (s === undefined || s.trim() === "") return def;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
};
const bool = (env: Env, key: string, def: boolean): boolean => {
  const s = env[key];
  return s === undefined || s === "" ? def : ["1", "true", "yes", "on"].includes(s.toLowerCase());
};

/** Config from env (RUNNER_TICK_SEC, EPOCH_SEC, MAX_SLIPPAGE_BPS, MIN_MARKET_DAY_VOLUME_USD, DRY_RUN, ...). */
export function loadRunnerConfig(env: Env = process.env): RunnerConfig {
  const d = DEFAULT_CONFIG;
  return {
    runner: {
      tickSec: num(env, "RUNNER_TICK_SEC", d.runner.tickSec),
      receiptsFlushSec: num(env, "RECEIPTS_FLUSH_SEC", d.runner.receiptsFlushSec),
      epochSec: num(env, "EPOCH_SEC", d.runner.epochSec),
      triggerMovePct: num(env, "TRIGGER_MOVE_PCT", d.runner.triggerMovePct),
      heartbeatSec: num(env, "TRIGGER_HEARTBEAT_SEC", d.runner.heartbeatSec),
      dryRun: bool(env, "DRY_RUN", d.runner.dryRun),
      allModeShortlist: Math.max(1, Math.floor(num(env, "ALL_MODE_SHORTLIST", d.runner.allModeShortlist))),
    },
    limits: {
      maxSlippageBps: num(env, "MAX_SLIPPAGE_BPS", d.limits.maxSlippageBps),
      minOrderUsd: num(env, "MIN_ORDER_USD", d.limits.minOrderUsd),
      maxDistinctPositions: Math.max(1, Math.floor(num(env, "MAX_DISTINCT_POSITIONS", d.limits.maxDistinctPositions))),
    },
    liquidity: {
      maxSpreadBps: num(env, "MAX_SPREAD_BPS", d.liquidity.maxSpreadBps),
      maxOrderPctOfDayVolume: num(env, "MAX_ORDER_PCT_OF_DAY_VOLUME", d.liquidity.maxOrderPctOfDayVolume),
      minMarketDayVolumeUsd: num(env, "MIN_MARKET_DAY_VOLUME_USD", d.liquidity.minMarketDayVolumeUsd),
      liquidDayVolumeUsd: num(env, "LIQUID_DAY_VOLUME_USD", d.liquidity.liquidDayVolumeUsd),
      bookBufferBps: num(env, "BOOK_BUFFER_BPS", d.liquidity.bookBufferBps),
      marketsSyncSec: num(env, "MARKETS_SYNC_SEC", d.liquidity.marketsSyncSec),
    },
    watchdog: {
      intervalSec: num(env, "WATCHDOG_INTERVAL_SEC", d.watchdog.intervalSec),
      positionToleranceBps: num(env, "WATCHDOG_POSITION_TOLERANCE_BPS", d.watchdog.positionToleranceBps),
      lossToleranceBps: num(env, "WATCHDOG_LOSS_TOLERANCE_BPS", d.watchdog.lossToleranceBps),
    },
  };
}

/** Deep-merge partial overrides into the defaults (handy for tests and embedding). */
export function runnerConfig(over: { [K in keyof RunnerConfig]?: Partial<RunnerConfig[K]> } = {}): RunnerConfig {
  return {
    runner: { ...DEFAULT_CONFIG.runner, ...over.runner },
    limits: { ...DEFAULT_CONFIG.limits, ...over.limits },
    liquidity: { ...DEFAULT_CONFIG.liquidity, ...over.liquidity },
    watchdog: { ...DEFAULT_CONFIG.watchdog, ...over.watchdog },
  };
}

/**
 * The platform's Lighter integrator (partner) account from env. Empty LIGHTER_INTEGRATOR_ACCOUNT_INDEX: no
 * attribution and no platform fee. Fees are in millionths (100 = 1 bp); the Robinhood Chain spot cap is 20000 (2%).
 */
export function loadIntegratorConfig(env: Env = process.env): IntegratorConfig {
  const raw = env.LIGHTER_INTEGRATOR_ACCOUNT_INDEX?.trim();
  const accountIndex = raw ? Number(raw) : null;
  if (accountIndex !== null && !(Number.isSafeInteger(accountIndex) && accountIndex > 0))
    throw new Error("LIGHTER_INTEGRATOR_ACCOUNT_INDEX must be a positive integer");
  const spotTakerFee = num(env, "LIGHTER_INTEGRATOR_SPOT_TAKER_FEE", 0);
  const spotMakerFee = num(env, "LIGHTER_INTEGRATOR_SPOT_MAKER_FEE", 0);
  for (const [k, v] of [
    ["LIGHTER_INTEGRATOR_SPOT_TAKER_FEE", spotTakerFee],
    ["LIGHTER_INTEGRATOR_SPOT_MAKER_FEE", spotMakerFee],
  ] as const)
    if (!(Number.isInteger(v) && v >= 0 && v <= LIGHTER_MAX_SPOT_FEE)) throw new Error(`${k} must be an integer in 0..${LIGHTER_MAX_SPOT_FEE}`);
  if (accountIndex === null && (spotTakerFee > 0 || spotMakerFee > 0)) throw new Error("a platform fee needs LIGHTER_INTEGRATOR_ACCOUNT_INDEX");
  return { accountIndex, spotTakerFee, spotMakerFee, required: bool(env, "LIGHTER_INTEGRATOR_REQUIRED", true) };
}
