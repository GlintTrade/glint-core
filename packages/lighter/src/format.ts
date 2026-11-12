// Lighter: prices and sizes are integers scaled by the market's price_decimals / size_decimals (orderBookDetails),
// see https://docs.lighter.xyz/developers/getting-started/core-concepts#integer-prices-and-sizes.
// There is no significant-figures rule: a price is valid with up to price_decimals decimals.
// Rounding is directional: a buy limit rounds DOWN, a sell limit rounds UP, so the 1% slippage cap is never exceeded;
// sizes always round DOWN (never buy or sell more than computed).
//
// All values are WIRE values (what the REST API returns and what the signer takes). Some RH stock markets have a
// `multiplier` != 1 (corporate-action adjustment); lighter-ts converts to "display" values with it, we never do:
// prices, sizes and balances are compared only with each other, all in wire units.

export interface MarketDecimals {
  szDecimals: number; // size_decimals
  priceDecimals: number; // price_decimals
}

function roundTo(x: number, decimals: number, mode: "down" | "up" | "nearest"): number {
  const f = 10 ** decimals;
  const scaled = x * f;
  // epsilon absorbs binary floating point artefacts (1.005 * 100 = 100.49999...)
  const eps = 1e-9 * Math.max(1, Math.abs(scaled));
  let r: number;
  if (mode === "down") r = Math.floor(scaled + eps);
  else if (mode === "up") r = Math.ceil(scaled - eps);
  else r = Math.round(scaled);
  return r / f;
}

export function toPlainString(x: number, decimals: number): string {
  const s = x.toFixed(decimals);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Order price as a decimal string with at most priceDecimals decimals. */
export function formatSpotPrice(px: number, priceDecimals: number, mode: "down" | "up" | "nearest" = "nearest"): string {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error(`invalid price ${px}`);
  const r = roundTo(px, priceDecimals, mode);
  if (!(r > 0)) throw new Error(`price ${px} rounds to zero`);
  return toPlainString(r, priceDecimals);
}

/** Size rounded down to szDecimals. "0" when it rounds to nothing. */
export function formatSpotSize(sz: number, szDecimals: number): string {
  if (!(sz > 0) || !Number.isFinite(sz)) return "0";
  const r = roundTo(sz, szDecimals, "down");
  return r > 0 ? toPlainString(r, szDecimals) : "0";
}

/** IOC limit: mid ± maxSlippageBps, rounded to the safe side. */
export function slippageLimitPrice(mid: number, side: "buy" | "sell", maxSlippageBps: number, priceDecimals: number): string {
  const raw = side === "buy" ? mid * (1 + maxSlippageBps / 10000) : mid * (1 - maxSlippageBps / 10000);
  return formatSpotPrice(raw, priceDecimals, side === "buy" ? "down" : "up");
}

/**
 * Decimal string → integer for the signer (exact, no float): "176.05" with 2 decimals → 17605.
 * Throws if the string has more decimals than allowed (the risk engine already formatted it).
 */
export function toScaledInt(value: string, decimals: number): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid decimal ${value}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`${value} has more than ${decimals} decimals`);
  const n = BigInt(m[1] + frac.padEnd(decimals, "0"));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${value} is too large`);
  return Number(n);
}
