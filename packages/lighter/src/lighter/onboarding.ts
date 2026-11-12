// Onboarding of an agent API key — SEPARATE from the agent signer (agent-signer.ts) and never used by the runner.
//
// Lighter flow (docs: create-accounts-programmatically, partner-attribution, wasm-signer "When an L1 signature is
// required"):
//  1. GenerateAPIKey → key pair (the platform stores the private key encrypted at rest).
//  2. ChangePubKey: L2-signed by the NEW key, plus an L1 signature of `messageToSign` by the account owner's wallet
//     (personal_sign). Always required.
//  3. ApproveIntegrator (our partner account, spot fees, expiry): L2-signed by the key; with a non-zero fee and a
//     partner of another owner (our case) it ALSO needs the owner's L1 signature. Zero-fee approvals would need no L1
//     signature — we never send those: without a fee there is nothing to approve.
//  4. Optional tier switch to Plus (non-zero partner fees need Plus/Premium): REST changeAccountTier with an auth
//     token of the key — only after the user signed our consent message.
// Every submission here requires a signature of the USER's wallet that we verify against the account's L1 address
// before sending. The L1 messages contain no expiry, the L2 part expires after ~10 min, so the L2 tx is re-signed at
// submission with the same nonce and the message is compared byte for byte with the one the user signed.
import { type Hex, verifyMessage } from "viem";
import { TX_TYPE } from "./agent-signer.js";
import type { LighterHttp } from "./http.js";
import type { OnboardingWasm } from "./wasm.js";

export interface KeyArgs {
  privateKey: string;
  publicKey: string; // hex, with or without 0x
  accountIndex: number;
  apiKeyIndex: number;
}

export interface IntegratorArgs {
  integratorAccountIndex: number;
  maxSpotTakerFee: number; // millionths
  maxSpotMakerFee: number;
  approvalExpiryMs: number;
}

/** What the API layer needs from onboarding (fakeable in tests). */
export interface OnboardingGateway {
  generateKey(): Promise<{ privateKey: string; publicKey: string }>;
  changePubKeyMessage(k: KeyArgs, nonce: number): Promise<string>;
  approveIntegratorMessage(k: KeyArgs, nonce: number, a: IntegratorArgs): Promise<string>;
  submitChangePubKey(k: KeyArgs, nonce: number, signed: { message: string; l1Address: Hex; signature: Hex }): Promise<{ txHash: string }>;
  submitApproveIntegrator(
    k: KeyArgs,
    nonce: number,
    a: IntegratorArgs,
    signed: { message: string; l1Address: Hex; signature: Hex },
  ): Promise<{ txHash: string }>;
  /** Switches the account tier via REST with an auth token of the (registered) key, after the user's signed consent. */
  changeTier(k: KeyArgs, tier: "plus", consent: { message: string; l1Address: Hex; signature: Hex }): Promise<void>;
}

export const ONBOARDING_TX_TYPES: ReadonlySet<number> = new Set([TX_TYPE.changePubKey, TX_TYPE.approveIntegrator]);

export class OnboardingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The user's personal_sign over exactly `message` by `l1Address`. */
export async function verifyUserSignature(l1Address: Hex, message: string, signature: Hex): Promise<boolean> {
  try {
    return await verifyMessage({ address: l1Address, message, signature });
  } catch {
    return false;
  }
}

const check = (name: string, res: any) => {
  if (res && typeof res === "object" && typeof res.error === "string" && res.error) throw new OnboardingError("signer_error", `${name}: ${res.error}`);
  return res;
};

export class LighterOnboardingGateway implements OnboardingGateway {
  constructor(private readonly o: { http: LighterHttp; chainId: number; wasm: () => Promise<OnboardingWasm> }) {}

  private async client(k: KeyArgs): Promise<OnboardingWasm> {
    const w = await this.o.wasm();
    check("CreateClient", w.CreateClient("", k.privateKey, this.o.chainId, k.apiKeyIndex, k.accountIndex));
    return w;
  }

  async generateKey(): Promise<{ privateKey: string; publicKey: string }> {
    const w = await this.o.wasm();
    const r = check("GenerateAPIKey", w.GenerateAPIKey());
    if (typeof r?.privateKey !== "string" || typeof r?.publicKey !== "string") throw new OnboardingError("signer_error", "GenerateAPIKey returned no key");
    return { privateKey: r.privateKey, publicKey: r.publicKey };
  }

  private async signChangePubKey(k: KeyArgs, nonce: number): Promise<{ txType: number; txInfo: string; messageToSign: string }> {
    const w = await this.client(k);
    const pub = k.publicKey.startsWith("0x") ? k.publicKey : `0x${k.publicKey}`;
    const r = check("SignChangePubKey", w.SignChangePubKey(pub, 0, nonce, k.apiKeyIndex, k.accountIndex));
    if (Number(r.txType) !== TX_TYPE.changePubKey || typeof r.messageToSign !== "string")
      throw new OnboardingError("signer_error", "unexpected ChangePubKey result");
    return { txType: Number(r.txType), txInfo: r.txInfo, messageToSign: r.messageToSign };
  }

  private async signApproveIntegrator(k: KeyArgs, nonce: number, a: IntegratorArgs): Promise<{ txType: number; txInfo: string; messageToSign: string }> {
    const w = await this.client(k);
    const r = check(
      "SignApproveIntegrator",
      w.SignApproveIntegrator(
        a.integratorAccountIndex,
        0,
        0,
        a.maxSpotTakerFee,
        a.maxSpotMakerFee,
        a.approvalExpiryMs,
        0,
        nonce,
        k.apiKeyIndex,
        k.accountIndex,
      ),
    );
    if (Number(r.txType) !== TX_TYPE.approveIntegrator || typeof r.messageToSign !== "string")
      throw new OnboardingError("signer_error", "unexpected ApproveIntegrator result");
    return { txType: Number(r.txType), txInfo: r.txInfo, messageToSign: r.messageToSign };
  }

  async changePubKeyMessage(k: KeyArgs, nonce: number): Promise<string> {
    return (await this.signChangePubKey(k, nonce)).messageToSign;
  }

  async approveIntegratorMessage(k: KeyArgs, nonce: number, a: IntegratorArgs): Promise<string> {
    return (await this.signApproveIntegrator(k, nonce, a)).messageToSign;
  }

  private async send(tx: { txType: number; txInfo: string }, l1Sig: Hex): Promise<{ txHash: string }> {
    if (!ONBOARDING_TX_TYPES.has(tx.txType)) throw new OnboardingError("refused", `refusing tx type ${tx.txType}`);
    const info = JSON.parse(tx.txInfo);
    info.L1Sig = l1Sig;
    const r = await this.o.http.postForm("/api/v1/sendTx", { tx_type: String(tx.txType), tx_info: JSON.stringify(info) });
    return { txHash: String(r.tx_hash ?? "") };
  }

  async submitChangePubKey(k: KeyArgs, nonce: number, signed: { message: string; l1Address: Hex; signature: Hex }): Promise<{ txHash: string }> {
    const tx = await this.signChangePubKey(k, nonce); // fresh L2 expiry, same nonce
    if (tx.messageToSign !== signed.message) throw new OnboardingError("message_mismatch", "the ChangePubKey message changed; sign the new one");
    if (!(await verifyUserSignature(signed.l1Address, tx.messageToSign, signed.signature)))
      throw new OnboardingError("bad_signature", "the signature is not from the account owner");
    return this.send(tx, signed.signature);
  }

  async submitApproveIntegrator(
    k: KeyArgs,
    nonce: number,
    a: IntegratorArgs,
    signed: { message: string; l1Address: Hex; signature: Hex },
  ): Promise<{ txHash: string }> {
    if (!(a.maxSpotTakerFee > 0 || a.maxSpotMakerFee > 0)) throw new OnboardingError("refused", "zero-fee approvals are not sent");
    const tx = await this.signApproveIntegrator(k, nonce, a);
    if (tx.messageToSign !== signed.message) throw new OnboardingError("message_mismatch", "the ApproveIntegrator message changed; sign the new one");
    if (!(await verifyUserSignature(signed.l1Address, tx.messageToSign, signed.signature)))
      throw new OnboardingError("bad_signature", "the signature is not from the account owner");
    return this.send(tx, signed.signature);
  }

  async changeTier(k: KeyArgs, tier: "plus", consent: { message: string; l1Address: Hex; signature: Hex }): Promise<void> {
    if (!(await verifyUserSignature(consent.l1Address, consent.message, consent.signature)))
      throw new OnboardingError("bad_signature", "the consent is not signed by the account owner");
    const w = await this.client(k);
    const r = check("CreateAuthToken", w.CreateAuthToken(Math.floor(Date.now() / 1000) + 600, k.apiKeyIndex, k.accountIndex));
    await this.o.http.postForm("/api/v1/changeAccountTier", { account_index: String(k.accountIndex), new_tier: tier }, { authorization: r.authToken });
  }
}
