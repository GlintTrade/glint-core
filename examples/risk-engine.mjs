// Feed an AI decision through the deterministic risk engine and the order-book liquidity guard.
// Run after `npm run build`:  node examples/risk-engine.mjs
import { checkLiquidity, evaluateDecision } from "@glint/risk";
import { PRESETS } from "@glint/strategy";

const trend = PRESETS.find((p) => p.key === "trend");

// What the model proposed (untrusted input).
const decision = {
  note: "NVDA trend confirmed, SPY overextended",
  actions: [
    { type: "buy", market: "NVDA", sizeBps: 2000, reason: "fast EMA above slow EMA, RSI 58" },
    { type: "buy", market: "SPY", sizeBps: 6000, reason: "chasing the breakout" }, // too large
    { type: "buy", market: "DOGE", sizeBps: 500, reason: "not one of the agent's markets" },
  ],
};

const result = evaluateDecision({
  spec: { markets: ["NVDA", "SPY"], risk: trend.defaults.balanced.risk },
  preset: trend,
  params: trend.defaults.balanced.params,
  indicators: { NVDA: [181.2, 176.4, 58], SPY: [612, 598, 74] }, // ema20, ema50, rsi14 per preset.indicators
  markets: [
    { symbol: "NVDA", coin: "NVDA/USDG", hlSpotIndex: 2048, szDecimals: 3, priceDecimals: 2 }, // Lighter market_id and decimals
    { symbol: "SPY", coin: "SPY/USDG", hlSpotIndex: 2049, szDecimals: 3, priceDecimals: 2 },
  ],
  balances: { usdc: 1000, tokens: {} },
  mids: { NVDA: 180, SPY: 610 },
  tradesToday: 0,
  dailyPnlBps: 0,
  decision,
});

console.log("approved orders:");
for (const o of result.orders) console.log(`  ${o.side} ${o.sizeBase} ${o.market} @ ${o.limitPx} IOC (market ${o.marketId}, ~$${o.notionalUsd.toFixed(2)})`);
console.log("rejected:");
for (const r of result.rejections) console.log(`  #${r.index} ${r.action.type} ${r.action.market}: ${r.code} (${r.message})`);

// Every approved order is then checked against the live L2 book.
const book = {
  bids: Array.from({ length: 10 }, (_, i) => ({ px: 180 * (1 - 0.0005 * (i + 1)), sz: 50 })),
  asks: Array.from({ length: 10 }, (_, i) => ({ px: 180 * (1 + 0.0005 * (i + 1)), sz: 50 })),
};
const first = result.orders[0];
const liq = checkLiquidity(
  { side: first.side, sizeBase: Number(first.sizeBase), limitPx: Number(first.limitPx), szDecimals: first.szDecimals, priceDecimals: first.priceDecimals },
  book,
  2_000_000,
  {
    maxSpreadBps: 150,
    maxSlippageBps: 100,
    maxOrderPctOfDayVolume: 2,
    minMarketDayVolumeUsd: 5000,
    minOrderUsd: 10,
  },
);
console.log("liquidity guard:", liq.ok ? `ok, limit tightened to ${liq.limitPx}, spread ${liq.spreadBps.toFixed(1)} bps` : liq);
