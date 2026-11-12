// Agent capital: a virtual sub-account on top of a shared Lighter account (pure functions, no network).
//
// Problem: several agents of one user trade on ONE Lighter account (quote USDG; the ledger's `usdc` field holds USDG). Without sub-accounts each sees the whole
// balance: two DCA agents spend the same USDG, a Protect agent sells tokens a DCA agent bought.
//
// Model:
//  - allocationUsd: how much USDG the user allocated to the agent at creation (stored off-chain, NOT in the spec:
//    a purchased marketplace copy has the seller's spec but the buyer's own capital).
//  - Agent ledger = allocation - sum(buys, USD) + sum(sells, USD); tokens = bought - sold (from the agent's OWN trades).
//  - Reconciliation with the real Lighter balance on every tick: if the ledgers of active agents add up to more
//    than the real balance (Lighter fees, manual user actions), shares are scaled down proportionally, so an agent
//    never spends more than really exists.
//  - manageExistingHoldings (Protect by default): the agent "adopts" account tokens that no running agent owns
//    (bought manually, or by a stopped agent) and may sell them.
//  - Legacy agents without an allocation: "whole account" is allowed only when no other agent uses that Lighter
//    account; otherwise (for presets that buy) the agent is paused with a clear reason.

export interface LedgerTrade {
  side: "buy" | "sell";
  market: string;
  sizeUsd: number;
  sizeBase: number;
}

export interface Ledger {
  usdc: number;
  tokens: Record<string, number>;
  /** Average entry price from the agent's own trades (USD per token). */
  avgEntry: Record<string, number>;
  realizedPnlUsd: number;
}

export function ledgerFromTrades(allocationUsd: number, trades: LedgerTrade[]): Ledger {
  let usdc = Math.max(0, allocationUsd);
  const tokens: Record<string, number> = {};
  const cost: Record<string, number> = {};
  let realized = 0;
  for (const t of trades) {
    const q = Math.max(0, t.sizeBase);
    if (!(q > 0)) continue;
    if (t.side === "buy") {
      usdc -= t.sizeUsd;
      tokens[t.market] = (tokens[t.market] ?? 0) + q;
      cost[t.market] = (cost[t.market] ?? 0) + t.sizeUsd;
    } else {
      const held = tokens[t.market] ?? 0;
      const sold = Math.min(held, q); // selling adopted tokens beyond its own: proceeds only, no cost basis
      const avg = held > 0 ? (cost[t.market] ?? 0) / held : 0;
      realized += sold * (t.sizeUsd / q - avg);
      cost[t.market] = Math.max(0, (cost[t.market] ?? 0) - sold * avg);
      tokens[t.market] = Math.max(0, held - q);
      usdc += t.sizeUsd;
    }
  }
  const avgEntry: Record<string, number> = {};
  for (const [m, q] of Object.entries(tokens)) if (q > 0 && cost[m] > 0) avgEntry[m] = cost[m] / q;
  return { usdc, tokens, avgEntry, realizedPnlUsd: realized };
}

export interface CapitalParticipant {
  agentId: number;
  /** null: created before capital allocations (whole account). */
  allocationUsd: number | null;
  trades: LedgerTrade[];
  /** The preset allows buys. */
  buys: boolean;
  /** Trading now: activated, on-chain Active, off-chain ok. Its tokens can never be adopted. */
  running: boolean;
  /** Reserves its USDG: activated and not Stopped (including paused: it may resume). */
  reserving: boolean;
}

export interface CapitalInput {
  self: CapitalParticipant & { manageExistingHoldings: boolean };
  others: CapitalParticipant[];
  /** Real free Lighter balances (total - hold). */
  real: { usdc: number; tokens: Record<string, number> };
}

export type CapitalResult =
  | {
      ok: true;
      mode: "ledger" | "whole_account";
      usdc: number;
      tokens: Record<string, number>;
      /** Tokens adopted under manageExistingHoldings, by symbol. */
      adopted: Record<string, number>;
      /** Average entry price from own trades. */
      avgEntry: Record<string, number>;
      allocationUsd: number | null;
      realizedPnlUsd: number;
      /** Reconciliation scaled a share down (the real balance is below the ledger). */
      scaledDown: string[];
    }
  | { ok: false; reason: "allocation_required"; message: string };

const EPS = 1e-9;

export function capitalView(input: CapitalInput): CapitalResult {
  const { self, others, real } = input;
  if (self.allocationUsd === null && self.buys) {
    const sharing = others.filter((o) => o.reserving);
    if (sharing.length > 0)
      return {
        ok: false,
        reason: "allocation_required",
        message: `this agent was created without a capital allocation and other agents (#${sharing.map((o) => o.agentId).join(", #")}) use the same Lighter account; recreate it with an allocation`,
      };
    // the only agent on the account: legacy behaviour, the whole account
    const own = ledgerFromTrades(0, self.trades);
    return {
      ok: true,
      mode: "whole_account",
      usdc: Math.max(0, real.usdc),
      tokens: { ...real.tokens },
      adopted: {},
      avgEntry: own.avgEntry,
      allocationUsd: null,
      realizedPnlUsd: own.realizedPnlUsd,
      scaledDown: [],
    };
  }

  const own = ledgerFromTrades(self.allocationUsd ?? 0, self.trades);
  const ledgers = others.map((o) => ({ o, l: ledgerFromTrades(o.allocationUsd ?? 0, o.trades) }));
  const scaledDown: string[] = [];

  // USDG: split the real balance proportionally to the ledgers of reserving agents
  const ownUsdc = Math.max(0, own.usdc);
  const sumUsdc = ownUsdc + ledgers.filter((x) => x.o.reserving).reduce((s, x) => s + Math.max(0, x.l.usdc), 0);
  let usdc = ownUsdc;
  if (sumUsdc > real.usdc + EPS) {
    usdc = sumUsdc > 0 ? (Math.max(0, real.usdc) * ownUsdc) / sumUsdc : 0;
    if (ownUsdc - usdc > 0.01) scaledDown.push("USDG");
  }

  // tokens: own (from own trades), reconciled with the real balance; other agents' tokens are reserved
  const tokens: Record<string, number> = {};
  const adopted: Record<string, number> = {};
  const symbols = new Set([...Object.keys(own.tokens), ...Object.keys(real.tokens)]);
  for (const sym of symbols) {
    const realQ = Math.max(0, real.tokens[sym] ?? 0);
    const ownQ = Math.max(0, own.tokens[sym] ?? 0);
    // tokens of paused agents are reserved too: a pause must not hand positions to another agent for selling
    // (production finding: a Protect agent adopted the tokens of a Trend agent paused by the watchdog). Only tokens of
    // stopped agents and manually bought tokens are free.
    const othersQ = ledgers.filter((x) => x.o.running || x.o.reserving).reduce((s, x) => s + Math.max(0, x.l.tokens[sym] ?? 0), 0);
    const sum = ownQ + othersQ;
    let q = ownQ;
    if (sum > realQ + EPS) {
      q = sum > 0 ? (realQ * ownQ) / sum : 0;
      // Lighter charges spot fees in the received asset, so the real balance can be slightly below the ledger.
      // The quantity is always corrected; "scaled down" is reported only for a noticeable gap (> 0.5%).
      if (ownQ > 0 && (ownQ - q) / ownQ > 0.005) scaledDown.push(sym);
    }
    if (self.manageExistingHoldings) {
      const free = Math.max(0, realQ - Math.min(sum, realQ));
      if (free > EPS) {
        adopted[sym] = free;
        q += free;
      }
    }
    if (q > EPS) tokens[sym] = q;
  }
  return {
    ok: true,
    mode: "ledger",
    usdc,
    tokens,
    adopted,
    avgEntry: own.avgEntry,
    allocationUsd: self.allocationUsd,
    realizedPnlUsd: own.realizedPnlUsd,
    scaledDown,
  };
}

/**
 * USDG on the account not yet allocated to agents (for the creation wizard): real free USDG minus the ledger USDG of
 * reserving agents. A running agent without an allocation that buys occupies the whole account, so 0.
 */

export function unallocatedUsdc(
  realUsdc: number,
  participants: CapitalParticipant[],
): { unallocated: number; allocated: number; wholeAccountAgentId: number | null } {
  const whole = participants.find((p) => p.running && p.buys && p.allocationUsd === null);
  if (whole) return { unallocated: 0, allocated: Math.max(0, realUsdc), wholeAccountAgentId: whole.agentId };
  const allocated = participants
    .filter((p) => p.reserving && p.allocationUsd !== null)
    .reduce((s, p) => s + Math.max(0, ledgerFromTrades(p.allocationUsd!, p.trades).usdc), 0);
  return { unallocated: Math.max(0, realUsdc - allocated), allocated, wholeAccountAgentId: null };
}
