// Risk engine: a deterministic pure function that outranks the AI.
// Input: spec, preset rights, balances, prices, today's trades and PnL, the AI decision.
// Output: approved orders (already rounded to the Lighter market's size and price decimals) and rejections with reasons.
// No preset-specific branches: rights come from allowsBuy/allowsSell, rules from preset.rules.
import { formatSpotPrice, formatSpotSize, slippageLimitPrice } from "@glint/lighter";
import { type AgentAction, type AgentDecision, type GenericParams, isAllMarkets, LIMITS, type PresetInfo, type StrategySpec } from "@glint/strategy";
import { evalConditions, numParam, weightsParam } from "./rules.js";

/** Rebalance tolerance: a buy/sell may overshoot the target by at most this many bps of equity. */
export const REBALANCE_TOLERANCE_BPS = 50;

export interface RiskMarket {
  symbol: string;
  coin: string;
  hlSpotIndex: number; // Lighter market_id
  szDecimals: number;
  /** Lighter price_decimals (default 2: every RH stock pair). */
  priceDecimals?: number;
  /**
   * Whether BUYING is allowed on this market (enabled by the platform and part of the agent's set).
   * Selling a held position is allowed on any known market, even a disabled or illiquid one. Default true.
   */
  buyable?: boolean;
  /** Why buying is not allowed: "min_order" = the agent's capital/limits cannot reach the minimum order after lot rounding. */
  unbuyableReason?: "disabled" | "min_order" | "closed";
}

export interface RiskInput {
  spec: Pick<StrategySpec, "markets" | "risk">;
  preset: Pick<PresetInfo, "allowsBuy" | "allowsSell"> & Partial<Pick<PresetInfo, "rules">>;
  /** Agent params (for preset.rules: buy interval/budget, buy-below prices). */
  params?: GenericParams;
  /** Preset indicator values by index (preset.indicators) per market, for rules.buyWhen. */
  indicators?: Record<string, (number | null)[]>;
  /** Seconds since the agent's last buy (null = no buys yet), for rules.minBuyIntervalParam. */
  secondsSinceLastBuy?: number | null;
  /**
   * Markets known to the agent this tick: its pairs (or the shortlist in "*" mode) plus markets of held positions.
   * Buys only on buyable markets; sells on any of them while a position exists.
   */
  markets: RiskMarket[];
  /** Available balances (total - hold): USDG (field `usdc`) and tokens by symbol. */
  balances: { usdc: number; tokens: Record<string, number> };
  /** Mid prices by symbol. */
  mids: Record<string, number>;
  tradesToday: number;
  /** Daily PnL in bps (negative = loss). */
  dailyPnlBps: number;
  /** Protect-only mode (e.g. every AI provider failed). */
  protectOnly?: boolean;
  /** Activation time and current time (seconds), for durationDays. */
  startedAt?: number;
  nowSec?: number;
  limits?: { minOrderUsd?: number; maxSlippageBps?: number; maxDistinctPositions?: number };
  /** Enabled markets outside the agent's set that cannot be bought with its capital/lot ("*" mode), for a clear rejection. */
  unbuyable?: Record<string, "min_order">;
  decision: AgentDecision;
}

export interface RiskOptions {
  /** Protective sells by code: not counted against the daily trade limit and not blocked by protectOnly. */
  protective?: boolean;
}

export type RejectCode =
  | "too_many_actions"
  | "invalid_action"
  | "market_not_in_spec"
  | "market_not_whitelisted"
  | "market_closed"
  | "side_not_allowed"
  | "invalid_size"
  | "max_trades_per_day"
  | "no_price"
  | "protect_only"
  | "daily_loss_limit"
  | "duration_expired"
  | "trade_too_large"
  | "no_capital"
  | "insufficient_usdc"
  | "position_limit"
  | "too_many_positions"
  | "exceeds_target"
  // preset rules (preset.rules) enforced by code
  | "buy_too_soon"
  | "buy_budget_exceeded"
  | "above_buy_price"
  | "buy_condition_failed"
  | "no_position"
  | "limit_out_of_band"
  | "below_min_order"
  // liquidity guard (liquidity.ts), applied to every order after evaluateDecision
  | "illiquid_market"
  | "no_book"
  | "spread_too_wide"
  | "order_too_large_for_volume"
  | "insufficient_depth"
  | "price_impact_too_high";

export interface ApprovedOrder {
  index: number;
  market: string;
  coin: string;
  marketId: number; // Lighter market_id
  szDecimals: number;
  priceDecimals: number;
  side: "buy" | "sell";
  sizeBase: string; // string with szDecimals
  limitPx: string; // string with priceDecimals (worst acceptable IOC price)
  notionalUsd: number; // estimate at mid
  tif: "Ioc";
  reason: string;
}

export interface Rejection {
  index: number;
  action: AgentAction;
  code: RejectCode;
  message: string;
}

export interface RiskResult {
  orders: ApprovedOrder[];
  rejections: Rejection[];
  equityUsd: number;
}

/**
 * Agent equity = USDG + token value at mid. Without `markets` (or in ["*"] mode) every token in balances.tokens counts
 * (the runner snapshot only puts the agent's markets and held positions there).
 */
export function computeEquity(balances: RiskInput["balances"], mids: Record<string, number>, markets?: string[]): number {
  let eq = Math.max(0, balances.usdc);
  const list = !markets || isAllMarkets(markets) ? Object.keys(balances.tokens) : markets;
  for (const m of list) {
    const q = balances.tokens[m] ?? 0;
    const px = mids[m];
    if (q > 0 && px > 0) eq += q * px;
  }
  return eq;
}

const fmtUsd = (x: number) => x.toFixed(2);

export function evaluateDecision(input: RiskInput, opts: RiskOptions = {}): RiskResult {
  const minOrderUsd = input.limits?.minOrderUsd ?? LIMITS.minOrderUsd;
  const maxSlippageBps = input.limits?.maxSlippageBps ?? LIMITS.maxSlippageBps;
  const { risk } = input.spec;
  const allMode = isAllMarkets(input.spec.markets);
  const specMarkets = new Set(input.spec.markets);
  const whitelist = new Map(input.markets.map((m) => [m.symbol, m]));
  const maxDistinct = input.limits?.maxDistinctPositions ?? 8;

  // working copy of balances: later actions in the same batch see the effect of earlier ones
  let usdc = Math.max(0, input.balances.usdc);
  const tokens: Record<string, number> = { ...input.balances.tokens };
  const equity = computeEquity(input.balances, input.mids, allMode ? undefined : input.spec.markets);

  const orders: ApprovedOrder[] = [];
  const rejections: Rejection[] = [];
  const reject = (index: number, action: AgentAction, code: RejectCode, message: string) => rejections.push({ index, action, code, message });

  const actions = Array.isArray(input.decision?.actions) ? input.decision.actions : [];
  actions.forEach((action, index) => {
    // the action cap applies to AI decisions only: protective exits by code (stops, exitWhen) are never capped
    if (!opts.protective && index >= LIMITS.actionsPerDecisionMax)
      return reject(index, action, "too_many_actions", `at most ${LIMITS.actionsPerDecisionMax} actions per decision`);
    if (!action || typeof action !== "object") return reject(index, action, "invalid_action", "invalid action");
    if (action.type === "hold") return;
    if (action.type !== "buy" && action.type !== "sell") return reject(index, action, "invalid_action", `unknown action type ${String(action.type)}`);
    const side = action.type;
    const reason = String(action.reason ?? "").slice(0, LIMITS.reasonMax);

    // preset rights first (clear reason: "the preset does not buy" rather than "market disabled")
    if (side === "buy" && !input.preset.allowsBuy) return reject(index, action, "side_not_allowed", "the preset does not allow buys");
    if (side === "sell" && !input.preset.allowsSell) return reject(index, action, "side_not_allowed", "the preset does not allow sells");
    if (!allMode && !specMarkets.has(action.market)) return reject(index, action, "market_not_in_spec", `${action.market} is not one of the agent's markets`);
    const mkt = whitelist.get(action.market);
    if (!mkt) {
      if (side === "sell" && !((tokens[action.market] ?? 0) > 0)) return reject(index, action, "no_position", `no ${action.market} position`);
      if (side === "buy" && input.unbuyable?.[action.market] === "min_order")
        return reject(
          index,
          action,
          "below_min_order",
          `with the agent's capital and limits a ${action.market} buy cannot reach the ${minOrderUsd} USD minimum order (lot size)`,
        );
      return reject(index, action, "market_not_whitelisted", `${action.market} is not in the platform whitelist`);
    }
    // market not buyable: the agent's capital cannot reach the minimum lot, or the market is disabled/illiquid
    if (side === "buy" && mkt.buyable === false) {
      if (mkt.unbuyableReason === "min_order")
        return reject(
          index,
          action,
          "below_min_order",
          `with the agent's capital and limits a ${action.market} buy cannot reach the ${minOrderUsd} USD minimum order (lot size)`,
        );
      if (mkt.unbuyableReason === "closed")
        return reject(index, action, "market_closed", `${action.market} is closed or halted on the exchange: no buys until it reopens`);
      return reject(index, action, "market_not_whitelisted", `${action.market} is disabled or illiquid: only selling an existing position is allowed`);
    }
    if (!Number.isInteger(action.sizeBps) || action.sizeBps < 1 || action.sizeBps > 10000)
      return reject(index, action, "invalid_size", "sizeBps must be an integer 1..10000");
    if (!opts.protective && input.tradesToday + orders.length >= risk.maxTradesPerDay)
      return reject(index, action, "max_trades_per_day", `daily trade limit of ${risk.maxTradesPerDay} reached`);

    const mid = input.mids[action.market];
    if (!(mid > 0)) return reject(index, action, "no_price", `no price for ${action.market}`);
    const pxDec = mkt.priceDecimals ?? 2;

    // limit price: either from the AI (within the slippage band) or mid +/- maxSlippageBps
    let limitPx: string;
    const band = side === "buy" ? mid * (1 + maxSlippageBps / 10000) : mid * (1 - maxSlippageBps / 10000);
    if (action.limitPriceUsd !== undefined && action.limitPriceUsd !== null) {
      const lp = Number(action.limitPriceUsd);
      if (!(lp > 0) || (side === "buy" && lp > band) || (side === "sell" && lp < band))
        return reject(index, action, "limit_out_of_band", `limitPriceUsd is outside the allowed slippage of ${maxSlippageBps} bps from mid`);
      limitPx = formatSpotPrice(lp, pxDec, side === "buy" ? "down" : "up");
    } else {
      limitPx = slippageLimitPrice(mid, side, maxSlippageBps, pxDec);
    }
    const px = Number(limitPx);

    if (side === "buy") {
      if (input.protectOnly) return reject(index, action, "protect_only", "protect-only mode: new buys are not allowed");
      if (input.dailyPnlBps <= -risk.maxDailyLossBps)
        return reject(index, action, "daily_loss_limit", `daily loss ${-input.dailyPnlBps} bps >= limit ${risk.maxDailyLossBps} bps: sells only`);
      if (risk.durationDays > 0 && input.startedAt !== undefined && input.nowSec !== undefined && input.nowSec > input.startedAt + risk.durationDays * 86400)
        return reject(index, action, "duration_expired", "agent duration has expired: new buys are not allowed");
      if (action.sizeBps > risk.maxTradeBps) return reject(index, action, "trade_too_large", `sizeBps ${action.sizeBps} > maxTradeBps ${risk.maxTradeBps}`);
      // preset rules (data): buy interval and budget, buy-below price, indicator entry conditions
      const rules = input.preset.rules;
      if (rules) {
        const minGap = numParam(input.params, rules.minBuyIntervalParam);
        if (minGap !== undefined && minGap > 0) {
          const since = input.secondsSinceLastBuy;
          if ((since !== undefined && since !== null && since < minGap) || orders.some((o) => o.side === "buy"))
            return reject(index, action, "buy_too_soon", `buys are allowed at most once every ${minGap} s (last buy ${since ?? 0} s ago)`);
        }
        const budget = numParam(input.params, rules.maxBuyBpsParam);
        if (budget !== undefined && budget > 0 && action.sizeBps > budget)
          return reject(index, action, "buy_budget_exceeded", `sizeBps ${action.sizeBps} > the preset budget per buy of ${budget} bps`);
        const below = rules.buyBelowParam ? input.params?.[rules.buyBelowParam] : undefined;
        const cap = below && typeof below === "object" ? Number((below as Record<string, number>)[action.market]) : NaN;
        if (cap > 0 && mid > cap) return reject(index, action, "above_buy_price", `${action.market} mid ${mid} is above the buy-below price ${cap}`);
        if (rules.buyWhen?.length) {
          const ok = evalConditions(rules.buyWhen, input.indicators?.[action.market], mid, input.params);
          if (ok !== true)
            return reject(
              index,
              action,
              "buy_condition_failed",
              ok === null ? "entry condition: indicator data is unavailable" : "entry condition of the preset is not met",
            );
        }
      }
      if (!(equity > 0)) return reject(index, action, "no_capital", "no capital");
      const notional = (equity * action.sizeBps) / 10000;
      if (notional > usdc + 1e-9) return reject(index, action, "insufficient_usdc", `needs ${fmtUsd(notional)} USDG, available ${fmtUsd(usdc)}`);
      const posValue = (tokens[action.market] ?? 0) * mid;
      if (allMode && posValue < minOrderUsd) {
        const held = Object.entries(tokens).filter(([sym, q]) => sym !== action.market && q * (input.mids[sym] ?? 0) >= minOrderUsd).length;
        if (held >= maxDistinct)
          return reject(index, action, "too_many_positions", `already holding ${held} tokens: the limit is ${maxDistinct} distinct positions`);
      }
      // rules.maxPositionsParam: at most N distinct tokens held (a new position beyond that is rejected)
      const maxPos = numParam(input.params, input.preset.rules?.maxPositionsParam);
      if (maxPos !== undefined && maxPos > 0 && posValue < minOrderUsd) {
        const heldN = Object.entries(tokens).filter(([sym, q]) => sym !== action.market && q * (input.mids[sym] ?? 0) >= minOrderUsd).length;
        if (heldN >= maxPos) return reject(index, action, "too_many_positions", `already holding ${heldN} tokens: the preset limit is ${maxPos} positions`);
      }
      const afterBps = ((posValue + notional) / equity) * 10000;
      // rules.rebalance: a buy cannot lift the token share above its target (+ REBALANCE_TOLERANCE_BPS)
      const rb = input.preset.rules?.rebalance;
      if (rb) {
        const targets = weightsParam(input.params, rb.targetsParam) ?? {};
        const tgt = targets[action.market] ?? 0;
        if (afterBps > tgt + REBALANCE_TOLERANCE_BPS)
          return reject(index, action, "exceeds_target", `${action.market} share after the buy ${Math.round(afterBps)} bps > target ${tgt} bps`);
      }
      if (afterBps > risk.maxPositionBps + 1e-6)
        return reject(
          index,
          action,
          "position_limit",
          `${action.market} share after the trade ${Math.round(afterBps)} bps > maxPositionBps ${risk.maxPositionBps}`,
        );
      const sizeBase = formatSpotSize(notional / px, mkt.szDecimals);
      const qty = Number(sizeBase);
      if (!(qty > 0) || qty * Math.min(mid, px) < minOrderUsd) {
        const lotUsd = 10 ** -mkt.szDecimals * mid;
        const why =
          notional >= minOrderUsd
            ? ` after rounding to the lot size (${action.market} lot ≈ ${fmtUsd(lotUsd)}): ${sizeBase} ${action.market} ≈ ${fmtUsd(qty * mid)}`
            : ` (${fmtUsd(notional)})`;
        return reject(index, action, "below_min_order", `order is below the ${minOrderUsd} USD minimum${why}`);
      }
      usdc -= qty * px;
      tokens[action.market] = (tokens[action.market] ?? 0) + qty;
      orders.push({
        index,
        market: action.market,
        coin: mkt.coin,
        marketId: mkt.hlSpotIndex,
        szDecimals: mkt.szDecimals,
        priceDecimals: pxDec,
        side,
        sizeBase,
        limitPx,
        notionalUsd: qty * mid,
        tif: "Ioc",
        reason,
      });
      return;
    }

    // sell: sizeBps is a share of the current position
    const position = tokens[action.market] ?? 0;
    if (!(position > 0)) return reject(index, action, "no_position", `no ${action.market} position`);
    const sizeBase = formatSpotSize((position * action.sizeBps) / 10000, mkt.szDecimals);
    const qty = Math.min(Number(sizeBase), position);
    if (!(qty > 0) || qty * Math.min(mid, px) < minOrderUsd) return reject(index, action, "below_min_order", `order is below the ${minOrderUsd} USD minimum`);
    // rules.rebalance: an AI sell cannot push the token share below its target (- tolerance). Protective stops are exempt.

    const rbs = input.preset.rules?.rebalance;
    if (rbs && !opts.protective && equity > 0) {
      const tgt = (weightsParam(input.params, rbs.targetsParam) ?? {})[action.market] ?? 0;
      const afterSellBps = (((position - qty) * mid) / equity) * 10000;
      if (tgt > 0 && afterSellBps < tgt - REBALANCE_TOLERANCE_BPS)
        return reject(index, action, "exceeds_target", `${action.market} share after the sell ${Math.round(afterSellBps)} bps < target ${tgt} bps`);
    }
    tokens[action.market] = position - qty;
    usdc += qty * px;
    orders.push({
      index,
      market: action.market,
      coin: mkt.coin,
      marketId: mkt.hlSpotIndex,
      szDecimals: mkt.szDecimals,
      priceDecimals: pxDec,
      side,
      sizeBase: formatSpotSize(qty, mkt.szDecimals),
      limitPx,
      notionalUsd: qty * mid,
      tif: "Ioc",
      reason,
    });
  });

  return { orders, rejections, equityUsd: equity };
}
