// What activation and the runner check on Lighter before an agent may trade, and the platform fee of an order.
//
//  • The agent key must be registered (ChangePubKey) on the Lighter account of hlAccount at its slot. Blocking.
//  • Platform fee (partner attribution, docs: partner-attribution, account-types): attribution needs a valid
//    ApproveIntegrator by the user; a non-zero fee additionally needs the account on Plus or Premium (Lighter rejects
//    partner fees on Standard). A missing or expired approval does NOT stop the agent: it trades with a zero
//    platform fee and the state says so (feeMode).
import type { ExchangeClient, LighterKeyStore } from "@glint/lighter";
import type { LighterFeeMode } from "@glint/strategy";
import { type Hex, lc } from "./types.js";

export const PAID_TIERS: ReadonlySet<string> = new Set(["plus", "premium"]);

/** The platform's Lighter integrator (partner) account and its fee. Fees in millionths: 100 = 1 bp. */
export interface IntegratorConfig {
  /** null: no partner attribution, no fee. */
  accountIndex: number | null;
  spotTakerFee: number;
  spotMakerFee: number;
  /** Activation requires the integrator approval when a fee is configured. */
  required: boolean;
}

export const NO_INTEGRATOR: IntegratorConfig = { accountIndex: null, spotTakerFee: 0, spotMakerFee: 0, required: false };

/** A platform fee is configured (integrator account and a non-zero spot fee). */
export function platformFeeOn(ig: IntegratorConfig): boolean {
  return ig.accountIndex !== null && (ig.spotTakerFee > 0 || ig.spotMakerFee > 0);
}

export interface IntegratorApproval {
  approved: boolean;
  maxSpotTakerFee: number;
  maxSpotMakerFee: number;
  expiresAt: number | null; // unix ms
}

export interface ApprovalState {
  problems: string[];
  integrator: IntegratorApproval;
}

export function feeModeOf(ig: IntegratorConfig, approved: boolean, tier: string | null): LighterFeeMode {
  if (!platformFeeOn(ig)) return "disabled";
  if (!approved) return "zero_fee_no_approval";
  if (!tier || !PAID_TIERS.has(tier)) return "zero_fee_standard_tier";
  return "charged";
}

/**
 * The agent key is registered on the account of hlAccount at its slot, and (when a platform fee is configured and
 * required) the integrator is approved.
 */
export async function checkLighterApprovals(
  exchange: Pick<ExchangeClient, "apiKeys" | "account">,
  keyRows: Pick<LighterKeyStore, "byWallet">,
  hlAccount: Hex,
  apiWallet: Hex,
  ig: IntegratorConfig,
  nowSec: number,
): Promise<ApprovalState> {
  const problems: string[] = [];
  const integrator: IntegratorApproval = { approved: false, maxSpotTakerFee: 0, maxSpotMakerFee: 0, expiresAt: null };
  const row = keyRows.byWallet(apiWallet);
  if (!row) return { problems: ["lighter_key_unknown"], integrator };
  if (lc(row.l1Address) !== lc(hlAccount)) return { problems: ["lighter_account_mismatch"], integrator };
  const [keys, acc] = await Promise.all([exchange.apiKeys(row.accountIndex), exchange.account(row.accountIndex)]);
  if (!acc || lc(acc.l1Address) !== lc(hlAccount)) problems.push("lighter_account_mismatch");
  if (!keys.some((k) => k.apiKeyIndex === row.apiKeyIndex && k.publicKey === row.publicKey)) problems.push("lighter_key_not_registered");
  if (platformFeeOn(ig)) {
    const a = acc?.approvedIntegrators.find((x) => x.accountIndex === ig.accountIndex);
    if (a && a.approvalExpiry > nowSec * 1000) {
      integrator.approved = true;
      integrator.maxSpotTakerFee = a.maxSpotTakerFee;
      integrator.maxSpotMakerFee = a.maxSpotMakerFee;
      integrator.expiresAt = a.approvalExpiry;
    }
    if (ig.required && !integrator.approved) problems.push("lighter_integrator_not_approved");
  }
  return { problems, integrator };
}

/** Partner fields for an order: attribution only with a valid approval; a non-zero fee only on Plus/Premium. */
export function integratorForOrder(
  ig: IntegratorConfig,
  st: IntegratorApproval,
  tier: string | null,
): { fields?: { accountIndex: number; takerFee: number; makerFee: number }; feeMode: LighterFeeMode } {
  const mode = feeModeOf(ig, st.approved, tier);
  if (ig.accountIndex === null || mode === "disabled" || mode === "zero_fee_no_approval") return { feeMode: mode };
  const paid = mode === "charged";
  return {
    feeMode: mode,
    fields: {
      accountIndex: ig.accountIndex,
      takerFee: paid ? Math.min(ig.spotTakerFee, st.maxSpotTakerFee) : 0,
      makerFee: paid ? Math.min(ig.spotMakerFee, st.maxSpotMakerFee) : 0,
    },
  };
}
