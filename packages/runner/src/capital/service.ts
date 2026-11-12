// Store-backed glue between the pure capital ledger (ledger.ts) and the runner / watchdog.
import { type ExchangeClient, QUOTE } from "@glint/lighter";
import type { PresetInfo, StrategySpec } from "@glint/strategy";
import type { RunnerStore } from "../store.js";
import { type AgentRecord, type Hex, lc } from "../types.js";
import { type CapitalParticipant, type CapitalResult, capitalView, unallocatedUsdc } from "./ledger.js";

/** The agent manages "ownerless" account tokens: the preset flag; a boolean params.manageExistingHoldings overrides it. */
export function managesExistingHoldings(preset: Pick<PresetInfo, "manageExistingHoldings"> | undefined, spec: Pick<StrategySpec, "params"> | null): boolean {
  const p = spec?.params?.manageExistingHoldings;
  if (typeof p === "boolean") return p;
  return preset?.manageExistingHoldings === true;
}

export function isRunning(a: AgentRecord): boolean {
  return a.activated && a.chainStatus === 0 && a.offchainStatus === "ok";
}

export function isReserving(a: AgentRecord): boolean {
  return a.activated && a.chainStatus !== 2 && a.offchainStatus !== "killed";
}

export function participantOf(store: RunnerStore, a: AgentRecord): CapitalParticipant {
  const cap = store.getCapital(a.id);
  const preset = store.getPresetById(a.presetId);
  const buys = preset?.allowsBuy ?? true;
  return {
    agentId: a.id,
    // a never-buy agent holds no USDG allocation, even if one was stored for it (it would block the next agent)
    allocationUsd: !buys && cap?.allocationUsd ? 0 : (cap?.allocationUsd ?? null),
    trades: store.allTradesAsc(a.id).map((t) => ({ side: t.side, market: t.market, sizeUsd: t.sizeUsd, sizeBase: t.sizeBase })),
    buys,
    running: isRunning(a),
    reserving: isReserving(a),
  };
}

/** Every activated agent on this Lighter account (same L1 = hlAccount), except exceptId. */
export function agentsOnAccount(store: RunnerStore, hlAccount: string, exceptId?: number): AgentRecord[] {
  return store.listAgents({ activatedOnly: true }).filter((a) => lc(a.hlAccount) === lc(hlAccount) && a.id !== exceptId);
}

/** The agent's capital given the real free Lighter balances (total - hold). */
export function computeAgentCapital(store: RunnerStore, agent: AgentRecord, real: { usdc: number; tokens: Record<string, number> }): CapitalResult {
  const preset = store.getPresetById(agent.presetId);
  const self = { ...participantOf(store, agent), manageExistingHoldings: managesExistingHoldings(preset, agent.spec) };
  const others = agentsOnAccount(store, agent.hlAccount, agent.id).map((a) => participantOf(store, a));
  return capitalView({ self, others, real });
}

/** Real free balances of the L1's Lighter account: USDG (as `usdc`, the ledger's quote field) and tokens. */
export async function realBalances(exchange: Pick<ExchangeClient, "spotBalances">, hlAccount: Hex): Promise<{ usdc: number; tokens: Record<string, number> }> {
  const raw = await exchange.spotBalances(hlAccount);
  const out = { usdc: 0, tokens: {} as Record<string, number> };
  for (const b of raw) {
    const free = Math.max(0, b.total - b.hold);
    if (b.coin === QUOTE) out.usdc = free;
    else if (free > 0) out.tokens[b.coin] = free;
  }
  return out;
}

/** USDG on the account not yet allocated to agents (for an agent creation flow). */
export async function unallocatedOnAccount(
  store: RunnerStore,
  exchange: Pick<ExchangeClient, "spotBalances">,
  hlAccount: Hex,
): Promise<{ freeUsdg: number; allocated: number; unallocated: number; wholeAccountAgentId: number | null }> {
  const real = await realBalances(exchange, hlAccount);
  const u = unallocatedUsdc(
    real.usdc,
    agentsOnAccount(store, hlAccount).map((a) => participantOf(store, a)),
  );
  return { freeUsdg: real.usdc, ...u };
}

/** Capital check for a new agent. Returns an error code and message, or null when the allocation is acceptable. */
export function allocationError(
  cap: { minAgentCapitalUsd: number; minOrderUsd: number; unallocatedUsd: number; wholeAccountAgentId: number | null },
  allocationUsd: number | null,
  presetBuys: boolean,
): { code: string; message: string } | null {
  if (!presetBuys && (allocationUsd === null || allocationUsd === 0)) return null; // sell-only (Protect): no capital needed
  if (allocationUsd === null || !Number.isFinite(allocationUsd))
    return { code: "allocation_required", message: `allocationUsd is required: how much USDG this agent may use (min ${cap.minAgentCapitalUsd})` };
  if (allocationUsd < cap.minAgentCapitalUsd)
    return {
      code: "allocation_too_small",
      message: `allocationUsd ${allocationUsd} is below the minimum of ${cap.minAgentCapitalUsd} USDG (Lighter minimum order is ${cap.minOrderUsd} USDG)`,
    };
  if (cap.wholeAccountAgentId !== null)
    return {
      code: "account_in_use",
      message: `agent #${cap.wholeAccountAgentId} uses the whole Lighter account (created before capital allocations): stop it first`,
    };
  if (allocationUsd > cap.unallocatedUsd + 1e-6)
    return {
      code: "allocation_exceeds_free",
      message: `allocationUsd ${allocationUsd} > unallocated USDG ${cap.unallocatedUsd.toFixed(2)} on this Lighter account`,
    };
  return null;
}
