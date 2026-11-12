import type { AgentAction, RiskBox } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { computeEquity, evaluateDecision, type RiskInput } from "../src/index.js";

const risk: RiskBox = { maxPositionBps: 5000, maxTradeBps: 2500, maxDailyLossBps: 600, maxTradesPerDay: 5, durationDays: 30 };
const markets = [
  { symbol: "NVDA", coin: "NVDA/USDG", hlSpotIndex: 107, szDecimals: 2 },
  { symbol: "SPY", coin: "SPY/USDG", hlSpotIndex: 140, szDecimals: 5 },
  { symbol: "AMD", coin: "AMD/USDG", hlSpotIndex: 200, szDecimals: 3 },
];

function input(actions: AgentAction[], over: Partial<RiskInput> = {}): RiskInput {
  return {
    spec: { markets: ["NVDA", "SPY"], risk },
    preset: { allowsBuy: true, allowsSell: true },
    markets,
    balances: { usdc: 1000, tokens: { NVDA: 0, SPY: 0 } },
    mids: { NVDA: 40, SPY: 100000, AMD: 150 },
    tradesToday: 0,
    dailyPnlBps: 0,
    limits: { minOrderUsd: 10, maxSlippageBps: 100 },
    decision: { actions, note: "" },
    ...over,
  };
}

const buy = (market: string, sizeBps: number, extra: Partial<AgentAction> = {}): AgentAction => ({ type: "buy", market, sizeBps, reason: "r", ...extra });
const sell = (market: string, sizeBps: number, extra: Partial<AgentAction> = {}): AgentAction => ({ type: "sell", market, sizeBps, reason: "r", ...extra });

describe("risk engine", () => {
  it("approves a buy: IOC limit at mid + slippage, size by szDecimals, Lighter market id", () => {
    const r = evaluateDecision(input([buy("NVDA", 2000)]));
    expect(r.rejections).toEqual([]);
    expect(r.orders).toHaveLength(1);
    const o = r.orders[0];
    expect(o.side).toBe("buy");
    expect(o.marketId).toBe(107);
    expect(o.priceDecimals).toBe(2);
    expect(o.tif).toBe("Ioc");
    expect(o.limitPx).toBe("40.4"); // 40 * 1.01
    // 200 USD / 40.4 = 4.9504... rounded down to 2 decimals
    expect(o.sizeBase).toBe("4.95");
    expect(o.notionalUsd).toBeCloseTo(198, 5);
  });

  it("hold and an empty list do nothing", () => {
    const r = evaluateDecision(input([{ type: "hold", market: "", sizeBps: 0, reason: "" }]));
    expect(r.orders).toEqual([]);
    expect(r.rejections).toEqual([]);
  });

  it("sell: share of the position, limit at mid - slippage rounded up", () => {
    const r = evaluateDecision(input([sell("NVDA", 5000)], { balances: { usdc: 0, tokens: { NVDA: 10 } } }));
    expect(r.rejections).toEqual([]);
    expect(r.orders[0].sizeBase).toBe("5");
    expect(r.orders[0].limitPx).toBe("39.6");
  });

  const rejectCases: [string, RiskInput, string][] = [
    ["market not in spec.markets", input([buy("AMD", 100)]), "market_not_in_spec"],
    ["market not whitelisted", input([buy("UETH", 100)], { spec: { markets: ["UETH"], risk } }), "market_not_whitelisted"],
    ["preset forbids buys", input([buy("NVDA", 100)], { preset: { allowsBuy: false, allowsSell: true } }), "side_not_allowed"],
    [
      "preset forbids sells",
      input([sell("NVDA", 100)], { preset: { allowsBuy: true, allowsSell: false }, balances: { usdc: 0, tokens: { NVDA: 10 } } }),
      "side_not_allowed",
    ],
    ["fractional sizeBps", input([buy("NVDA", 10.5)]), "invalid_size"],
    ["sizeBps = 0", input([buy("NVDA", 0)]), "invalid_size"],
    ["sizeBps > 10000", input([sell("NVDA", 10001)], { balances: { usdc: 0, tokens: { NVDA: 10 } } }), "invalid_size"],
    ["daily trade limit", input([buy("NVDA", 100)], { tradesToday: 5 }), "max_trades_per_day"],
    ["no price", input([buy("NVDA", 1000)], { mids: { SPY: 1 } }), "no_price"],
    ["protect-only mode", input([buy("NVDA", 1000)], { protectOnly: true }), "protect_only"],
    ["daily loss limit", input([buy("NVDA", 1000)], { dailyPnlBps: -600 }), "daily_loss_limit"],
    ["duration expired", input([buy("NVDA", 1000)], { startedAt: 0, nowSec: 31 * 86400 }), "duration_expired"],
    ["trade above maxTradeBps", input([buy("NVDA", 2600)]), "trade_too_large"],
    ["no capital", input([buy("NVDA", 1000)], { balances: { usdc: 0, tokens: {} } }), "no_capital"],
    ["not enough USDG", input([buy("NVDA", 2000)], { balances: { usdc: 100, tokens: { SPY: 0.009 } } }), "insufficient_usdc"],
    ["share after trade > maxPositionBps", input([buy("NVDA", 2000)], { balances: { usdc: 600, tokens: { NVDA: 10 } } }), "position_limit"],
    ["no position to sell", input([sell("NVDA", 10000)]), "no_position"],
    ["buy below the minimum order", input([buy("NVDA", 50)]), "below_min_order"],
    ["sell below the minimum order", input([sell("NVDA", 10000)], { balances: { usdc: 1000, tokens: { NVDA: 0.2 } } }), "below_min_order"],
    ["limit price above the band (buy)", input([buy("NVDA", 1000, { limitPriceUsd: 41 })]), "limit_out_of_band"],
    [
      "limit price below the band (sell)",
      input([sell("NVDA", 5000, { limitPriceUsd: 39 })], { balances: { usdc: 0, tokens: { NVDA: 10 } } }),
      "limit_out_of_band",
    ],
    ["unknown action type", input([{ type: "short" as "buy", market: "NVDA", sizeBps: 100, reason: "" }]), "invalid_action"],
  ];
  for (const [name, inp, code] of rejectCases) {
    it(`rejects: ${name} -> ${code}`, () => {
      const r = evaluateDecision(inp);
      expect(r.orders).toEqual([]);
      expect(r.rejections.map((x) => x.code)).toEqual([code]);
      expect(r.rejections[0].message.length).toBeGreaterThan(0);
    });
  }

  it("sells stay allowed after the daily loss limit", () => {
    const r = evaluateDecision(input([sell("NVDA", 10000)], { dailyPnlBps: -5000, balances: { usdc: 0, tokens: { NVDA: 10 } } }));
    expect(r.orders).toHaveLength(1);
  });

  it("protect-only does not block sells", () => {
    const r = evaluateDecision(input([sell("NVDA", 10000)], { protectOnly: true, balances: { usdc: 0, tokens: { NVDA: 10 } } }));
    expect(r.orders).toHaveLength(1);
  });

  it("more than 3 actions: the extra ones are rejected", () => {
    const r = evaluateDecision(input([buy("NVDA", 300), buy("SPY", 300), buy("NVDA", 300), buy("SPY", 300)]));
    expect(r.orders).toHaveLength(3);
    expect(r.rejections.map((x) => x.code)).toEqual(["too_many_actions"]);
  });

  it("actions in a batch see the effect of earlier ones (USDG and the trade limit)", () => {
    const r1 = evaluateDecision(input([buy("NVDA", 2500), buy("SPY", 2500), buy("NVDA", 2500)], { balances: { usdc: 1000, tokens: {} } }));
    expect(r1.orders).toHaveLength(3);
    const r2 = evaluateDecision(input([buy("NVDA", 300), buy("SPY", 300)], { tradesToday: 4 }));
    expect(r2.orders).toHaveLength(1);
    expect(r2.rejections[0].code).toBe("max_trades_per_day");
    // the position grows inside the batch: 2 buys of 25% -> 50% is fine, the third hits the limit
    const r3 = evaluateDecision(input([buy("NVDA", 2500), buy("NVDA", 2500), buy("NVDA", 100)]));
    expect(r3.orders).toHaveLength(2);
    expect(r3.rejections[0].code).toBe("position_limit");
  });

  it("protective: the daily trade limit does not apply", () => {
    const r = evaluateDecision(input([sell("NVDA", 10000)], { tradesToday: 99, balances: { usdc: 0, tokens: { NVDA: 10 } } }), { protective: true });
    expect(r.orders).toHaveLength(1);
  });

  it("limitPriceUsd inside the band is used as the limit", () => {
    const r = evaluateDecision(input([buy("NVDA", 1000, { limitPriceUsd: 39.5 })]));
    expect(r.orders[0].limitPx).toBe("39.5");
  });

  it("price rounded to priceDecimals (default 2), size to szDecimals", () => {
    const r = evaluateDecision(input([buy("SPY", 2000)], { mids: { NVDA: 40, SPY: 98765.4321 } }));
    expect(r.orders[0].limitPx).toBe("99753.08"); // 98765.4321 * 1.01 = 99753.0864 -> 2 decimals
    expect(r.orders[0].sizeBase).toBe("0.002"); // 200 / 99753.08 = 0.0020049 -> 0.00200
  });

  it("a closed or halted market: no buys (market_closed), a held position can still be sold", () => {
    const closed = markets.map((m) => (m.symbol === "NVDA" ? { ...m, buyable: false, unbuyableReason: "closed" as const } : m));
    const b = evaluateDecision(input([buy("NVDA", 1000)], { markets: closed }));
    expect(b.rejections.map((x) => x.code)).toEqual(["market_closed"]);
    const s = evaluateDecision(input([sell("NVDA", 10000)], { markets: closed, balances: { usdc: 0, tokens: { NVDA: 10 } } }));
    expect(s.rejections).toEqual([]);
    expect(s.orders[0]).toMatchObject({ side: "sell", marketId: 107, sizeBase: "10" });
  });

  it("equity = USDG + tokens of the agent's markets", () => {
    expect(computeEquity({ usdc: 100, tokens: { NVDA: 2, AMD: 10 } }, { NVDA: 40, AMD: 150 }, ["NVDA"])).toBe(180);
  });

  it("is deterministic: same input, same output", () => {
    const i = input([buy("NVDA", 1500), buy("SPY", 900)]);
    expect(evaluateDecision(i)).toEqual(evaluateDecision(i));
  });
});
