// Prompt for a trading decision. IMPORTANT: no Lighter account address or index and no absolute USD amounts,
// only shares (bps) and percentages. Market prices are public data and may be included.
import { type GenericParams, LIMITS, type PresetInfo, type RiskBox } from "@glint/strategy";

// ---------- preset prompt template: {{goal}}, {{risk}}, {{params}}, {{params.X}} ----------
// Unknown placeholders become "n/a" so the AI never sees raw braces.

export function formatRisk(risk: RiskBox): string {
  return [
    `max position per token ${risk.maxPositionBps} bps`,
    `max trade ${risk.maxTradeBps} bps of equity`,
    `max daily loss ${risk.maxDailyLossBps} bps`,
    `at most ${risk.maxTradesPerDay} trades per day`,
    risk.durationDays > 0 ? `duration ${risk.durationDays} days` : "no time limit",
  ].join(", ");
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "n/a";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function renderTemplate(template: string, vars: { goal: string; risk: RiskBox; params: GenericParams }): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, name: string) => {
    if (name === "goal") return vars.goal.trim() || "n/a";
    if (name === "risk") return formatRisk(vars.risk);
    if (name === "params") return JSON.stringify(vars.params);
    if (name.startsWith("params.")) {
      const key = name.slice("params.".length);
      return Object.hasOwn(vars.params, key) ? formatValue(vars.params[key]) : "n/a";
    }
    return "n/a";
  });
}

/** Placeholders used in a template (for preset validation). */
export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1]!);
}

// ---------- decision prompt ----------

export interface MarketContext {
  symbol: string;
  midUsd: number;
  changeSinceLastDecisionPct: number | null;
  indicators: Record<string, number | null>;
  positionBps: number; // share of equity held in the token
  unrealizedPnlPct: number | null; // vs the average entry price
  /** Whether buying is allowed (enabled, in the agent's set, the lot allows a minimum order). Default true. */
  buyable?: boolean;
  /** Minimum sell as a share of the position (bps); null = no position, or the whole position is below the minimum order. */
  minSellShareBps?: number | null;
  /** The market is closed or halted on the exchange (Lighter status not active, frozen, or outside its window). */
  closed?: boolean;
  closedReason?: string;
}

export interface DecisionContext {
  preset: Pick<PresetInfo, "key" | "promptTemplate" | "allowsBuy" | "allowsSell">;
  goal: string;
  risk: RiskBox;
  params: GenericParams;
  markets: MarketContext[];
  usdcBps: number; // share of equity in USDG (the quote)
  dailyPnlBps: number;
  tradesToday: number;
  protectOnly: boolean;
  secondsSinceLastTrade: number | null;
  nowIso: string;
  /** Exchange minimum order as a share of equity (bps); null = no capital. */
  minOrderShareBps?: number | null;
  /** Plan computed by code (rebalancing to targets): the AI executes or postpones it but never trades beyond targets. */
  codePlan?: { type: "buy" | "sell" | "hold"; market: string; sizeBps: number; reason: string }[];
}

const round = (x: number, d = 4) => Number(x.toFixed(d));

export function buildDecisionPrompt(ctx: DecisionContext): { system: string; user: string } {
  const system =
    renderTemplate(ctx.preset.promptTemplate, { goal: ctx.goal, risk: ctx.risk, params: ctx.params }) +
    `\n\nResponse format: JSON {"actions":[{"type":"buy|sell|hold","market":"SYMBOL","sizeBps":int,"limitPriceUsd":number|null,"reason":"..."}],"note":"..."}. ` +
    `At most ${LIMITS.actionsPerDecisionMax} actions. buy.sizeBps is a share of equity, sell.sizeBps is a share of the current position. ` +
    `Empty actions = hold. A risk engine checks every decision; limit violations are rejected. ` +
    `The risk limits and params in this prompt and in the payload are the agent's CURRENT settings and are authoritative: ` +
    `they override any number in the goal text (the goal may quote an older trade size or cap; ignore such numbers and size trades by the current limits). ` +
    `The exchange has a minimum order size: a buy must be at least portfolio.minOrderShareBps of equity, and a sell must be at least ` +
    `market.minSellShareBps of the position (10000 = the whole position; null = there is nothing sellable). Smaller orders are rejected, ` +
    `so never propose them — if a partial sell would be too small, either sell the whole position or hold. Buy only markets with buyable=true. ` +
    `A market with marketOpen=false is closed or halted on the exchange: never buy it; a sell may also fail until it reopens. ` +
    `protectOnly=true means new buys are temporarily disabled (e.g. the AI provider was briefly unavailable); it does NOT require selling — ` +
    `keep or exit positions only as your strategy says. Protective stops are executed by code anyway. ` +
    (ctx.codePlan?.length
      ? `The code computed codePlan — the trades that bring the portfolio back to its targets. Execute it (you may scale an action down ` +
        `or postpone it with a reason, e.g. extreme volatility), but never trade beyond the targets: such actions are rejected. `
      : "") +
    `Units: every *Pct field and the change*/volatility* indicators are already in PERCENT (e.g. -0.15 means -0.15%, not -15%); ` +
    `rsi* is 0-100; ema* and midUsd are prices in USD (USDG); *Bps fields are basis points (10000 = 100%). Quote numbers with these units. ` +
    `State profit or loss only from the numbers provided (unrealizedPnlPct, dailyPnlBps): a negative number is a loss; never call a position ` +
    `"in profit" unless its number is positive. ` +
    `Write "reason" and "note" in English.`;
  const allowed = [ctx.preset.allowsBuy && !ctx.protectOnly ? "buy" : null, ctx.preset.allowsSell ? "sell" : null, "hold"].filter(Boolean);
  const payload = {
    time: ctx.nowIso,
    allowedActions: allowed,
    protectOnly: ctx.protectOnly,
    portfolio: {
      usdgShareBps: Math.round(ctx.usdcBps),
      dailyPnlBps: Math.round(ctx.dailyPnlBps),
      tradesToday: ctx.tradesToday,
      maxTradesPerDay: ctx.risk.maxTradesPerDay,
      secondsSinceLastTrade: ctx.secondsSinceLastTrade,
      minOrderShareBps: ctx.minOrderShareBps ?? null,
    },
    ...(ctx.codePlan?.length ? { codePlan: ctx.codePlan } : {}),
    limits: {
      maxPositionBps: ctx.risk.maxPositionBps,
      maxTradeBps: ctx.risk.maxTradeBps,
      maxDailyLossBps: ctx.risk.maxDailyLossBps,
    },
    markets: ctx.markets.map((m) => ({
      symbol: m.symbol,
      midUsd: m.midUsd,
      changeSinceLastDecisionPct: m.changeSinceLastDecisionPct === null ? null : round(m.changeSinceLastDecisionPct, 3),
      positionShareBps: Math.round(m.positionBps),
      unrealizedPnlPct: m.unrealizedPnlPct === null ? null : round(m.unrealizedPnlPct, 2),
      buyable: m.buyable ?? true,
      minSellShareBps: m.minSellShareBps ?? null,
      ...(m.closed ? { marketOpen: false, closedReason: m.closedReason ?? "closed" } : {}),
      indicators: m.indicators,
    })),
  };
  return { system, user: `Current state (JSON):\n${JSON.stringify(payload)}\n\nMake your decision. Answer in English.` };
}
