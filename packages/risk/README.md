# @glint/risk

The deterministic risk engine. The AI proposes; this code decides.

`evaluateDecision(input)` is a pure function: the same input always gives the same orders and rejections. Every AI
action passes, in order:

1. **Preset rights**: `allowsBuy` / `allowsSell`.
2. **Market**: in the agent's set (or any buyable pair in `["*"]` mode) and open on the exchange (`market_closed`
   otherwise); selling a held position is allowed on any known market.
3. **Size and count**: integer `sizeBps` 1..10000, at most 3 actions per decision, `maxTradesPerDay`.
4. **Buys only**: protect-only mode, daily loss limit (`maxDailyLossBps`), duration, `maxTradeBps`, preset rules
   (minimum buy interval, budget per buy, buy-below price, indicator entry conditions), available USDG, distinct
   positions, rebalance targets, `maxPositionBps`, exchange minimum order after lot rounding.
5. **Price**: IOC limit at mid plus or minus `maxSlippageBps`, or the AI's limit if it is inside that band, rounded to
   the Lighter market's `priceDecimals` (and the size to `szDecimals`) in the safe direction.

Then `checkLiquidity` runs on every order against the live L2 book: 24h volume, spread, share of daily volume and a
book walk within the slippage band. AI orders are rejected in strict mode; protective sells are clipped to the size
that can fill, never cancelled outright.

Protective stops (`checkProtection`: stop-loss, trailing stop, take-profit) and preset exit rules are executed by
code on every runner tick, independent of the AI.

Rejection codes (`RejectCode`) are stable strings such as `position_limit`, `daily_loss_limit`, `buy_too_soon`,
`exceeds_target`, `spread_too_wide`. The runner stores them with each decision, so users see exactly why an action
was refused.

```ts
import { evaluateDecision } from "@glint/risk";

const { orders, rejections } = evaluateDecision({
  spec: { markets: ["NVDA"], risk: { maxPositionBps: 5000, maxTradeBps: 2500, maxDailyLossBps: 600, maxTradesPerDay: 5, durationDays: 0 } },
  preset: { allowsBuy: true, allowsSell: true },
  markets: [{ symbol: "NVDA", coin: "NVDA/USDG", hlSpotIndex: 2048, szDecimals: 3, priceDecimals: 2 }], // hlSpotIndex = Lighter market_id
  balances: { usdc: 1000, tokens: {} },
  mids: { NVDA: 180 },
  tradesToday: 0,
  dailyPnlBps: 0,
  decision: { actions: [{ type: "buy", market: "NVDA", sizeBps: 4000, reason: "breakout" }], note: "" },
});
// orders: []   rejections[0].code: "trade_too_large" (4000 bps > maxTradeBps 2500)
```

## License

BUSL-1.1, see [LICENSE](./LICENSE).
