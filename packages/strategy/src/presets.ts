import type { PresetInfo } from "./types.js";

// Built-in presets v1: spot only, no leverage, no shorts.
// Presets are DATA: indicators, a prompt template, code-enforced rules and protective stops.
// The runner and the risk engine have no preset-specific branches; everything below is interpreted generically.

const COMMON_RULES =
  "You are a spot trading agent on Lighter (Robinhood Chain). Trade only the allowed tokens (tokenized stocks and ETFs), quoted in USDG. " +
  "No leverage, no shorts. All sizes are fractions (bps) of equity or of the position. Reply strictly with JSON matching the schema. " +
  "A market marked closed cannot be bought. If there is no good opportunity, hold. Briefly explain every action in `reason`.";

export const PRESETS: PresetInfo[] = [
  {
    key: "dca",
    id: 0,
    title: "DCA",
    description: "Buys the selected tokens in portions on a schedule. The AI picks the timing and allocation. Never sells.",
    allowsBuy: true,
    allowsSell: false,
    enabled: true,
    builtin: true,
    indicators: [
      { kind: "change", lookback: 24, timeframe: "1h" },
      { kind: "rsi", period: 14, timeframe: "1h" },
    ],
    promptTemplate:
      COMMON_RULES +
      " Preset DCA: buys only. Buy at most once every {{params.buyEverySec}} seconds, about {{params.budgetPerBuyBps}} bps of equity each time. " +
      "Prefer dips (RSI below 45, a 24h decline). User goal: {{goal}}. Limits: {{risk}}.",
    rules: { minBuyIntervalParam: "buyEverySec", maxBuyBpsParam: "budgetPerBuyBps", buyBelowParam: "buyBelowUsd" },
    paramsSchema: [
      { key: "buyEverySec", label: "Min seconds between buys", type: "number", min: 300, max: 604800 },
      { key: "budgetPerBuyBps", label: "Budget per buy, bps", type: "number", min: 10, max: 10000 },
    ],
    defaults: {
      conservative: {
        risk: { maxPositionBps: 4000, maxTradeBps: 300, maxDailyLossBps: 500, maxTradesPerDay: 6, durationDays: 90 },
        params: { buyEverySec: 86400, budgetPerBuyBps: 300 },
      },
      balanced: {
        risk: { maxPositionBps: 6000, maxTradeBps: 500, maxDailyLossBps: 800, maxTradesPerDay: 12, durationDays: 90 },
        params: { buyEverySec: 21600, budgetPerBuyBps: 500 },
      },
      aggressive: {
        risk: { maxPositionBps: 8000, maxTradeBps: 1000, maxDailyLossBps: 1200, maxTradesPerDay: 24, durationDays: 90 },
        params: { buyEverySec: 3600, budgetPerBuyBps: 1000 },
      },
    },
  },
  {
    key: "protect",
    id: 1,
    title: "Protect",
    description: "Guards tokens you already hold: sells on stop-loss, takes profit, runs a trailing stop. Never opens new buys.",
    allowsBuy: false,
    allowsSell: true,
    enabled: true,
    builtin: true,
    // guards account tokens that no running agent owns (bought manually or by a paused agent)
    manageExistingHoldings: true,
    riskLabel: "low",
    indicators: [
      { kind: "change", lookback: 24, timeframe: "1h" },
      { kind: "volatility", lookback: 24, timeframe: "1h" },
    ],
    promptTemplate:
      COMMON_RULES +
      " Preset Protect: sells of existing holdings only. Hard stop-loss ({{params.stopLossPct}}%), take-profit ({{params.takeProfitPct}}%) and trailing stop ({{params.trailingPct}}%) are executed by code. " +
      "You decide whether to take partial profit or cut a position earlier when conditions clearly worsen. Goal: {{goal}}. Limits: {{risk}}.",
    protection: { stopLossParam: "stopLossPct", takeProfitParam: "takeProfitPct", trailingParam: "trailingPct" },
    paramsSchema: [
      { key: "stopLossPct", label: "Stop-loss, %", type: "number", min: 1, max: 50 },
      { key: "takeProfitPct", label: "Take-profit, %", type: "number", min: 1, max: 500 },
      { key: "trailingPct", label: "Trailing stop, %", type: "number", min: 1, max: 50 },
    ],
    defaults: {
      conservative: {
        risk: { maxPositionBps: 10000, maxTradeBps: 10000, maxDailyLossBps: 300, maxTradesPerDay: 10, durationDays: 0 },
        params: { stopLossPct: 5, takeProfitPct: 10, trailingPct: 4 },
      },
      balanced: {
        risk: { maxPositionBps: 10000, maxTradeBps: 10000, maxDailyLossBps: 600, maxTradesPerDay: 10, durationDays: 0 },
        params: { stopLossPct: 8, takeProfitPct: 20, trailingPct: 7 },
      },
      aggressive: {
        risk: { maxPositionBps: 10000, maxTradeBps: 10000, maxDailyLossBps: 1000, maxTradesPerDay: 10, durationDays: 0 },
        params: { stopLossPct: 15, takeProfitPct: 40, trailingPct: 12 },
      },
    },
  },
  {
    key: "trend",
    id: 2,
    title: "Trend",
    description: "Buys in an uptrend and moves to USDG in a downtrend. Long only, with a stop on every position.",
    allowsBuy: true,
    allowsSell: true,
    enabled: true,
    builtin: true,
    indicators: [
      { kind: "ema", period: 20, timeframe: "1h" },
      { kind: "ema", period: 50, timeframe: "1h" },
      { kind: "rsi", period: 14, timeframe: "1h" },
    ],
    promptTemplate:
      COMMON_RULES +
      " Preset Trend: buy when the fast EMA ({{params.fastEma}}) is above the slow EMA ({{params.slowEma}}) on the {{params.timeframe}} timeframe and the trend is confirmed; " +
      "sell to USDG on a reversal. The {{params.stopLossPct}}% stop-loss is executed by code. Goal: {{goal}}. Limits: {{risk}}.",
    protection: { stopLossParam: "stopLossPct" },
    // entry only in an uptrend (fast EMA > slow EMA), exit by code on a reversal (fast EMA < slow EMA)
    rules: {
      buyWhen: [{ left: { ind: 0 }, op: ">", right: { ind: 1 } }],
      exitWhen: [{ left: { ind: 0 }, op: "<", right: { ind: 1 } }],
    },
    paramsSchema: [
      { key: "timeframe", label: "Timeframe", type: "select", options: ["15m", "1h", "4h"] },
      { key: "fastEma", label: "Fast EMA", type: "number", min: 3, max: 100 },
      { key: "slowEma", label: "Slow EMA", type: "number", min: 5, max: 300 },
      { key: "stopLossPct", label: "Stop-loss, %", type: "number", min: 1, max: 50 },
    ],
    defaults: {
      conservative: {
        risk: { maxPositionBps: 3000, maxTradeBps: 1500, maxDailyLossBps: 300, maxTradesPerDay: 6, durationDays: 30 },
        params: { timeframe: "4h", fastEma: 20, slowEma: 50, stopLossPct: 5 },
      },
      balanced: {
        risk: { maxPositionBps: 5000, maxTradeBps: 2500, maxDailyLossBps: 600, maxTradesPerDay: 12, durationDays: 30 },
        params: { timeframe: "1h", fastEma: 20, slowEma: 50, stopLossPct: 7 },
      },
      aggressive: {
        risk: { maxPositionBps: 8000, maxTradeBps: 4000, maxDailyLossBps: 1000, maxTradesPerDay: 24, durationDays: 30 },
        params: { timeframe: "15m", fastEma: 9, slowEma: 21, stopLossPct: 10 },
      },
    },
  },
  {
    key: "rebalance",
    id: 3,
    title: "Rebalance",
    description:
      "Keeps a target portfolio (e.g. 50% SPY, 30% NVDA, rest USDG). When a token drifts beyond the band, the code computes the trades back to the targets; the AI can only postpone or scale them down.",
    allowsBuy: true,
    allowsSell: true,
    enabled: true,
    builtin: true,
    riskLabel: "medium",
    indicators: [
      { kind: "change", lookback: 24, timeframe: "1h" },
      { kind: "volatility", lookback: 24, timeframe: "1h" },
    ],
    promptTemplate:
      COMMON_RULES +
      " Preset Rebalance: keep the portfolio at the target weights {{params.targets}} (bps of equity, the rest stays in USDG) within a band of {{params.driftBandBps}} bps. " +
      "The code computes codePlan with the exact trades back to the targets. Execute it unless conditions are extreme (then postpone with a reason); never trade beyond the targets. " +
      "Goal: {{goal}}. Limits: {{risk}}.",
    rules: {
      rebalance: { targetsParam: "targets", bandParam: "driftBandBps", minIntervalParam: "minRebalanceSec" },
      maxBuyBpsParam: "maxRebalanceTradeBps",
    },
    paramsSchema: [
      { key: "targets", label: "Target weights (bps of equity)", type: "weights", min: 0, max: 10000 },
      { key: "driftBandBps", label: "Drift band, bps", type: "number", min: 50, max: 5000 },
      { key: "minRebalanceSec", label: "Min seconds between rebalances", type: "number", min: 300, max: 604800 },
      { key: "maxRebalanceTradeBps", label: "Max trade per rebalance, bps", type: "number", min: 100, max: 10000 },
    ],
    defaults: {
      conservative: {
        risk: { maxPositionBps: 6000, maxTradeBps: 3000, maxDailyLossBps: 600, maxTradesPerDay: 8, durationDays: 0 },
        params: { targets: { SPY: 4000 }, driftBandBps: 800, minRebalanceSec: 21600, maxRebalanceTradeBps: 3000 },
      },
      balanced: {
        risk: { maxPositionBps: 7000, maxTradeBps: 4000, maxDailyLossBps: 900, maxTradesPerDay: 12, durationDays: 0 },
        params: { targets: { SPY: 5000 }, driftBandBps: 500, minRebalanceSec: 3600, maxRebalanceTradeBps: 4000 },
      },
      aggressive: {
        risk: { maxPositionBps: 9000, maxTradeBps: 6000, maxDailyLossBps: 1500, maxTradesPerDay: 24, durationDays: 0 },
        params: { targets: { SPY: 7000 }, driftBandBps: 300, minRebalanceSec: 900, maxRebalanceTradeBps: 6000 },
      },
    },
  },
  {
    key: "momentum",
    id: 4,
    title: "Momentum (High risk)",
    description:
      "High risk. Chases strong breakouts on liquid pairs: buys only after a large 24h move confirmed by RSI and a fast EMA crossover, with a tight stop-loss, trailing stop and take-profit enforced by code. Expect frequent small losses and occasional large wins.",
    allowsBuy: true,
    allowsSell: true,
    enabled: true,
    builtin: true,
    riskLabel: "high",
    indicators: [
      { kind: "change", lookback: 24, timeframe: "1h" }, // 0: 24h change, %
      { kind: "rsi", period: 14, timeframe: "1h" }, // 1
      { kind: "ema", period: 9, timeframe: "15m" }, // 2: fast
      { kind: "ema", period: 21, timeframe: "15m" }, // 3: slow
    ],
    promptTemplate:
      COMMON_RULES +
      " Preset Momentum (high risk): buy only tokens with a strong breakout — 24h change at least {{params.minChange24hPct}}%, RSI between {{params.rsiMin}} and {{params.rsiMax}}, fast EMA above slow EMA. " +
      "Size about {{params.budgetPerBuyBps}} bps of equity, at most {{params.maxPositions}} positions, wait {{params.cooldownSec}} s between buys. " +
      "Stop-loss {{params.stopLossPct}}%, trailing {{params.trailingPct}}% and take-profit {{params.takeProfitPct}}% are executed by code; the code also exits when the fast EMA falls below the slow EMA. " +
      "Goal: {{goal}}. Limits: {{risk}}.",
    protection: { stopLossParam: "stopLossPct", takeProfitParam: "takeProfitPct", trailingParam: "trailingPct" },
    rules: {
      minBuyIntervalParam: "cooldownSec",
      maxBuyBpsParam: "budgetPerBuyBps",
      maxPositionsParam: "maxPositions",
      buyWhen: [
        { left: { ind: 0 }, op: ">=", right: { param: "minChange24hPct" } },
        { left: { ind: 1 }, op: ">=", right: { param: "rsiMin" } },
        { left: { ind: 1 }, op: "<=", right: { param: "rsiMax" } },
        { left: { ind: 2 }, op: ">", right: { ind: 3 } },
      ],
      exitWhen: [{ left: { ind: 2 }, op: "<", right: { ind: 3 } }],
    },
    paramsSchema: [
      { key: "minChange24hPct", label: "Min 24h change to enter, %", type: "number", min: 1, max: 100 },
      { key: "rsiMin", label: "RSI min", type: "number", min: 30, max: 90 },
      { key: "rsiMax", label: "RSI max", type: "number", min: 40, max: 99 },
      { key: "budgetPerBuyBps", label: "Budget per buy, bps", type: "number", min: 100, max: 10000 },
      { key: "maxPositions", label: "Max positions", type: "number", min: 1, max: 8 },
      { key: "cooldownSec", label: "Min seconds between buys", type: "number", min: 60, max: 86400 },
      { key: "stopLossPct", label: "Stop-loss, %", type: "number", min: 1, max: 30 },
      { key: "trailingPct", label: "Trailing stop, %", type: "number", min: 1, max: 30 },
      { key: "takeProfitPct", label: "Take-profit, %", type: "number", min: 2, max: 500 },
    ],
    defaults: {
      conservative: {
        risk: { maxPositionBps: 2500, maxTradeBps: 2500, maxDailyLossBps: 500, maxTradesPerDay: 6, durationDays: 14 },
        params: {
          minChange24hPct: 8,
          rsiMin: 55,
          rsiMax: 75,
          budgetPerBuyBps: 2500,
          maxPositions: 2,
          cooldownSec: 3600,
          stopLossPct: 4,
          trailingPct: 5,
          takeProfitPct: 15,
        },
      },
      balanced: {
        risk: { maxPositionBps: 4000, maxTradeBps: 4000, maxDailyLossBps: 1000, maxTradesPerDay: 12, durationDays: 14 },
        params: {
          minChange24hPct: 6,
          rsiMin: 55,
          rsiMax: 80,
          budgetPerBuyBps: 4000,
          maxPositions: 3,
          cooldownSec: 1800,
          stopLossPct: 5,
          trailingPct: 6,
          takeProfitPct: 25,
        },
      },
      aggressive: {
        risk: { maxPositionBps: 6000, maxTradeBps: 6000, maxDailyLossBps: 2000, maxTradesPerDay: 24, durationDays: 14 },
        params: {
          minChange24hPct: 4,
          rsiMin: 50,
          rsiMax: 85,
          budgetPerBuyBps: 6000,
          maxPositions: 3,
          cooldownSec: 600,
          stopLossPct: 6,
          trailingPct: 8,
          takeProfitPct: 40,
        },
      },
    },
  },
];

/**
 * "All liquid pairs" mode: spec.markets = ["*"] (the only element).
 * markets stays string[], so the canonical JSON, specHash and the contract are unchanged.
 * Selected pairs: 1..LIMITS.marketsMax real symbols.
 */
export const ALL_MARKETS = "*";
export function isAllMarkets(markets: readonly string[] | undefined | null): boolean {
  return !!markets && markets.length === 1 && markets[0] === ALL_MARKETS;
}

export const DEFAULT_INTERVAL_SEC = 300; // 5 minutes
export const INTERVAL_OPTIONS_SEC = [60, 300, 900, 3600]; // 60 is premium only

// Starter spot markets on Lighter RH (base symbols of SYMBOL/USDG pairs). market_id and decimals are filled by the
// backend from orderBookDetails; the market sync then enables every liquid spot pair automatically.
export const DEFAULT_MARKET_SYMBOLS = ["NVDA", "SPY", "QQQ"];

/**
 * Safety margin over the exchange's minimum order: a buy or sell is planned at least minOrderUsd * MIN_ORDER_MARGIN
 * (lot rounding, fill below mid, fees). One value for the site's capital check, the runner's buyable test and the
 * minimum share the decision AI is told.
 */
export const MIN_ORDER_MARGIN = 1.03;

export const LIMITS = {
  nameMax: 64,
  goalMax: 600,
  reasonMax: 280,
  marketsMax: 8,
  enabledModelsMax: 12, // how many AI models the platform may enable at the same time
  actionsPerDecisionMax: 3,
  maxSlippageBps: 100, // 1% from mid for aggressive IOC orders (Lighter: price = worst acceptable price)
  minOrderUsd: 10, // Lighter RH spot: min_quote_amount = 10 USDG on every pair (orderBookDetails)
} as const;
