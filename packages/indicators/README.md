# @glint/indicators

Pure technical indicators used by presets and by the risk engine's entry and exit rules.

| Function                                       | Meaning                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `ema(closes, period)`                          | exponential moving average seeded with the SMA                                   |
| `rsi(closes, period)`                          | Wilder's RSI, 0..100                                                             |
| `change(closes, lookback)`                     | price change over `lookback` candles, %                                          |
| `volatility(closes, lookback)`                 | sample standard deviation of returns, %                                          |
| `computeIndicators(specs, coin, fetchCandles)` | all indicators of a preset for one market, one candle request per timeframe      |
| `resolveIndicatorSpecs(specs, params)`         | applies agent overrides (`timeframe`, `fastEma`, `slowEma`) by naming convention |

Values are labelled `ema20_1h`, `rsi14_1h`, `change24_1h` and so on; the same labels appear in the AI prompt and in
rule evaluation. No I/O: the candle fetcher is injected (`LighterClient.candles` from `@glint/lighter` in production).

## License

BUSL-1.1, see [LICENSE](./LICENSE).
