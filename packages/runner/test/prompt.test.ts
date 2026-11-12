import { PRESETS } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { buildDecisionPrompt, type DecisionContext, formatRisk, renderTemplate, templatePlaceholders } from "../src/llm/prompt.js";

const risk = { maxPositionBps: 5000, maxTradeBps: 2500, maxDailyLossBps: 600, maxTradesPerDay: 12, durationDays: 30 };

describe("preset prompt template", () => {
  it("fills goal, risk, params.X, params; unknown -> n/a", () => {
    const out = renderTemplate("G={{goal}} R={{risk}} F={{params.fastEma}} M={{ params.map }} ALL={{params}} X={{params.nope}} Y={{weird}}", {
      goal: "accumulate NVDA",
      risk,
      params: { fastEma: 9, map: { NVDA: 30 } },
    });
    expect(out).toContain("G=accumulate NVDA");
    expect(out).toContain(`R=${formatRisk(risk)}`);
    expect(out).toContain("F=9");
    expect(out).toContain('M={"NVDA":30}');
    expect(out).toContain('ALL={"fastEma":9,"map":{"NVDA":30}}');
    expect(out).toContain("X=n/a");
    expect(out).toContain("Y=n/a");
    expect(out).not.toMatch(/\{\{/);
  });
  it("built-in templates render without raw placeholders", () => {
    for (const p of PRESETS) {
      const out = renderTemplate(p.promptTemplate, { goal: "g", risk: p.defaults.balanced.risk, params: p.defaults.balanced.params });
      expect(out).not.toMatch(/\{\{|n\/a/);
      expect(templatePlaceholders(p.promptTemplate).length).toBeGreaterThan(0);
    }
  });
});

describe("decision prompt", () => {
  const trend = PRESETS[2]!;
  const ctx: DecisionContext = {
    preset: trend,
    goal: "trend",
    risk,
    params: trend.defaults.balanced.params,
    markets: [{ symbol: "NVDA", midUsd: 41.234, changeSinceLastDecisionPct: 0.5, indicators: { ema20_1h: 40 }, positionBps: 1234.4, unrealizedPnlPct: 3.21 }],
    usdcBps: 8765.6,
    dailyPnlBps: -12,
    tradesToday: 2,
    protectOnly: true,
    secondsSinceLastTrade: 600,
    nowIso: "2026-11-06T00:00:00.000Z",
  };
  it("only shares and percentages, no addresses; protect-only removes buy", () => {
    const { system, user } = buildDecisionPrompt(ctx);
    expect(system).toContain("Preset Trend");
    expect(system).toContain("in English");
    expect(user).toContain("Answer in English");
    expect(user + system).not.toMatch(/0x[0-9a-fA-F]{40}/);
    const payload = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
    expect(payload.allowedActions).toEqual(["sell", "hold"]);
    expect(payload.portfolio.usdgShareBps).toBe(8766);
    expect(payload.markets[0].positionShareBps).toBe(1234);
    expect(JSON.stringify(payload)).not.toMatch(/equity|balance|usdcAmount/i);
  });
  it("the minimum order is passed only as shares: minOrderShareBps, minSellShareBps, buyable", () => {
    const { system, user } = buildDecisionPrompt({
      ...ctx,
      minOrderShareBps: 514,
      markets: [
        { ...ctx.markets[0]!, minSellShareBps: 8800, buyable: true },
        {
          symbol: "MU",
          midUsd: 611.8,
          changeSinceLastDecisionPct: null,
          indicators: {},
          positionBps: 0,
          unrealizedPnlPct: null,
          minSellShareBps: null,
          buyable: false,
        },
      ],
    });
    expect(system).toContain("minimum order size");
    // units are explicit (production finding: the AI read -0.146% as -14.6%)
    expect(system).toContain("already in PERCENT");
    // protect-only does not mean "sell" (production finding: the AI treated it as a request to exit)
    expect(system).toContain("does NOT require selling");
    const payload = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
    expect(payload.portfolio.minOrderShareBps).toBe(514);
    expect(payload.markets[0]).toMatchObject({ minSellShareBps: 8800, buyable: true });
    expect(payload.markets[1]).toMatchObject({ minSellShareBps: null, buyable: false });
    expect(user).not.toMatch(/\$|USD [0-9]/); // no absolute amounts
  });
  it("a closed market is marked marketOpen=false with its reason; the current limits override numbers in the goal", () => {
    const { system, user } = buildDecisionPrompt({ ...ctx, markets: [{ ...ctx.markets[0]!, closed: true, closedReason: "status:inactive" }] });
    expect(system).toContain("marketOpen=false");
    expect(system).toContain("CURRENT settings and are authoritative");
    expect(system).toContain("State profit or loss only from the numbers provided");
    const payload = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
    expect(payload.markets[0]).toMatchObject({ marketOpen: false, closedReason: "status:inactive" });
    expect(
      JSON.parse(
        buildDecisionPrompt(ctx)
          .user.replace(/^[^{]*/, "")
          .replace(/[^}]*$/, ""),
      ).markets[0].marketOpen,
    ).toBeUndefined();
  });
});
