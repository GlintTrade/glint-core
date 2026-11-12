// Markets: parsing the real Lighter RH orderBookDetails (mainnet fixture), tiers and market status
// (closed / frozen / trading window).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSpotMarket } from "../src/lighter/client.js";
import { marketOpenState, marketTier, parseSpotUsdgMarkets, withTier } from "../src/markets.js";
import type { ExchangeSpotMarket } from "../src/types.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/orderBookDetails.rh-mainnet.json", import.meta.url), "utf8")) as {
  order_book_details: unknown[];
  spot_order_book_details: unknown[];
};
const raw: ExchangeSpotMarket[] = fx.spot_order_book_details.map(parseSpotMarket).filter((m): m is ExchangeSpotMarket => !!m);

describe("parseSpotUsdgMarkets (real Lighter RH mainnet data)", () => {
  const markets = parseSpotUsdgMarkets(raw);

  it("27 SYMBOL/USDG spot pairs; perps are not included; coin = pair, hlSpotIndex = market_id", () => {
    expect(markets).toHaveLength(27);
    expect(markets.every((m) => m.pair === `${m.symbol}/USDG` && m.coin === m.pair && m.resolved && m.hlSpotIndex >= 2048)).toBe(true);
    const syms = markets.map((m) => m.symbol);
    for (const s of ["NVDA", "SPY", "QQQ", "TSLA", "SLV", "USO", "COIN", "CRCL"]) expect(syms).toContain(s);
  });

  it("sorted by 24h USDG volume; price and size decimals come from orderBookDetails", () => {
    for (let i = 1; i < markets.length; i++) expect(markets[i - 1].dayVolumeUsd!).toBeGreaterThanOrEqual(markets[i].dayVolumeUsd!);
    expect(markets[0]).toMatchObject({ symbol: "QQQ", marketId: 2064, szDecimals: 4, priceDecimals: 2, status: "active" });
    const nvda = markets.find((m) => m.symbol === "NVDA")!;
    expect(nvda).toMatchObject({ hlSpotIndex: 2054, coin: "NVDA/USDG", szDecimals: 4, priceDecimals: 2, minBaseAmount: 0.04 });
    expect(nvda.midUsd!).toBeGreaterThan(0);
    const pons = markets.find((m) => m.symbol === "PONS")!;
    expect(pons).toMatchObject({ szDecimals: 1, priceDecimals: 5 });
  });

  it("a listed pair without volume parses fine (it stays below the liquidity threshold, so it is not enabled)", () => {
    const empty = markets.find((m) => m.dayVolumeUsd === 0)!;
    expect(empty).toBeDefined();
    expect(empty.marketId).toBe(2048);
  });

  it("one pair per symbol: an active pair wins over an inactive one with more volume", () => {
    const a = { ...raw[0], pair: "ABC/USDG", base: "ABC", marketId: 3000, status: "active", dayQuoteVolume: 10 };
    const b = { ...raw[0], pair: "ABC/USDG", base: "ABC", marketId: 3001, status: "inactive", dayQuoteVolume: 1e9 };
    const r = parseSpotUsdgMarkets([b, a]);
    expect(r).toHaveLength(1);
    expect(r[0].marketId).toBe(3000);
  });

  it("tier by thresholds", () => {
    const t = { minMarketDayVolumeUsd: 5000, liquidDayVolumeUsd: 100000 };
    expect(marketTier(100000, t)).toBe("liquid");
    expect(marketTier(5000, t)).toBe("thin");
    expect(marketTier(4999, t)).toBe("illiquid");
    expect(marketTier(undefined, t)).toBe("illiquid");
  });

  it("withTier adds the tier and the open state", () => {
    const m = { ...markets[0], enabled: true };
    const t = { minMarketDayVolumeUsd: 1, liquidDayVolumeUsd: 2 };
    expect(withTier(m, t, 1_800_000_000_000)).toMatchObject({ tier: "liquid", open: true });
    expect(withTier({ ...m, isFrozen: true }, t)).toMatchObject({ open: false, closedReason: "frozen" });
  });
});

describe("market status (RH stocks and ETFs trade 24/7; closing happens only through status, freeze or window)", () => {
  const now = 1_800_000_000_000;
  it("active and not frozen: open", () => expect(marketOpenState({ status: "active", resolved: true }, now)).toEqual({ open: true }));
  it("inactive / in-settlement / settled: closed", () => {
    for (const s of ["inactive", "in-settlement", "waiting-for-settlement", "settled"])
      expect(marketOpenState({ status: s, resolved: true }, now)).toEqual({ open: false, reason: `status:${s}` });
  });
  it("is_frozen, before start_timestamp, after end_timestamp, delisted", () => {
    expect(marketOpenState({ status: "active", isFrozen: true, resolved: true }, now).reason).toBe("frozen");
    expect(marketOpenState({ status: "active", startTs: now + 1, resolved: true }, now).reason).toBe("not_started");
    expect(marketOpenState({ status: "active", endTs: now, resolved: true }, now).reason).toBe("ended");
    expect(marketOpenState({ status: "active", resolved: false }, now).reason).toBe("delisted");
  });
});
