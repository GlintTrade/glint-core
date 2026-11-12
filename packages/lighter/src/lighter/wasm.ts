// Loads the Lighter WASM signer (lighter-go wasm/main.go) and splits it into two capabilities.
//
// The WASM registers ~25 global functions, one per Lighter transaction type. Right after loading we copy ONLY the
// allowlisted functions into two frozen objects and DELETE every function the WASM registered from globalThis, so
// every other function is unreachable from the rest of the process:
//  • AGENT capability     — what the agent's API key may sign: create order, cancel order, cancel all, read auth token.
//  • ONBOARDING capability — key generation, ChangePubKey and ApproveIntegrator. Used only by onboarding.ts, and
//    only together with an L1 signature produced by the USER's wallet (verified before anything is sent).
// The agent signer (agent-signer.ts) adds its own allowlist on top and checks the tx type of every signed result.
//
// Network: the WASM never does HTTP (Go's net stack does not work in WASM). We always pass url "" and explicit
// nonces from /api/v1/nextNonce, never nonce = -1 (docs: quickstart-typescript, wasm-signer).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LIGHTER_SIGNER_PIN } from "./signer-pin.js";

export type WasmFn = (...args: unknown[]) => any;

/** WASM functions the agent capability exposes. Everything else is unreachable for agent code. */
export const AGENT_WASM_FUNCTIONS = ["CreateClient", "SignCreateOrder", "SignCancelOrder", "SignCancelAllOrders", "CreateAuthToken"] as const;
/** WASM functions the onboarding capability exposes (each submission needs the user's L1 signature). */
export const ONBOARDING_WASM_FUNCTIONS = ["GenerateAPIKey", "CreateClient", "SignChangePubKey", "SignApproveIntegrator", "CreateAuthToken"] as const;

export type AgentWasmFn = (typeof AGENT_WASM_FUNCTIONS)[number];
export type OnboardingWasmFn = (typeof ONBOARDING_WASM_FUNCTIONS)[number];
export type AgentWasm = Readonly<Record<AgentWasmFn, WasmFn>>;
export type OnboardingWasm = Readonly<Record<OnboardingWasmFn, WasmFn>>;

export interface SignerCapabilities {
  agent: AgentWasm;
  onboarding: OnboardingWasm;
}

function pick<K extends string>(raw: Record<string, unknown>, names: readonly K[]): Readonly<Record<K, WasmFn>> {
  const out = Object.create(null) as Record<K, WasmFn>;
  for (const n of names) {
    const f = raw[n];
    if (typeof f !== "function") throw new Error(`Lighter signer: function ${n} is missing in the WASM`);
    out[n] = f as WasmFn;
  }
  return Object.freeze(out);
}

/** Pure split (tested): only allowlisted names are copied; the rest of `raw` is not retained. */
export function splitCapabilities(raw: Record<string, unknown>): SignerCapabilities {
  return { agent: pick(raw, AGENT_WASM_FUNCTIONS), onboarding: pick(raw, ONBOARDING_WASM_FUNCTIONS) };
}

export interface SignerFiles {
  wasmPath: string;
  wasmExecPath: string;
  /** Extra allowed sha256 of the .wasm (LIGHTER_SIGNER_SHA256), besides the pinned build. */
  extraSha256?: string;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let loading: Promise<SignerCapabilities> | null = null;

/** Loads the WASM once per process (sha256 verified) and returns the two capabilities. */
export function loadLighterSigner(files: SignerFiles): Promise<SignerCapabilities> {
  if (!loading) {
    loading = doLoad(files).catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

async function doLoad(files: SignerFiles): Promise<SignerCapabilities> {
  const wasm = readFileSync(files.wasmPath);
  const exec = readFileSync(files.wasmExecPath);
  const allowed = new Set<string>([...LIGHTER_SIGNER_PIN.wasmSha256, ...(files.extraSha256 ? [files.extraSha256.toLowerCase()] : [])]);
  const wasmHash = sha256(wasm);
  if (!allowed.has(wasmHash))
    throw new Error(`Lighter signer: ${files.wasmPath} has sha256 ${wasmHash}, which is not pinned (packages/lighter/scripts/build-lighter-signer.sh)`);
  const execHash = sha256(exec);
  if (!(LIGHTER_SIGNER_PIN.wasmExecSha256 as readonly string[]).includes(execHash) && !files.extraSha256)
    throw new Error(`Lighter signer: ${files.wasmExecPath} has sha256 ${execHash}, expected wasm_exec.js of Go ${LIGHTER_SIGNER_PIN.goVersion}`);

  const g = globalThis as unknown as Record<string, unknown>;
  const before = new Set(Object.getOwnPropertyNames(g));
  await import(pathToFileURL(files.wasmExecPath).href); // defines globalThis.Go
  const GoCtor = g.Go as new () => { importObject: unknown; run(i: unknown): Promise<void> };
  if (typeof GoCtor !== "function") throw new Error("Lighter signer: wasm_exec.js did not define Go");
  const go = new GoCtor();
  const WA = g.WebAssembly as { instantiate(b: Uint8Array, imports: unknown): Promise<{ instance: unknown }> };
  const { instance } = await WA.instantiate(wasm, go.importObject);
  void go.run(instance); // never awaited: the Go runtime keeps serving calls
  const added = Object.getOwnPropertyNames(g).filter((k) => !before.has(k) && typeof g[k] === "function" && k !== "Go");
  const raw: Record<string, unknown> = {};
  for (const k of added) raw[k] = g[k];
  const caps = splitCapabilities(raw);
  // nothing the WASM registered stays reachable through globalThis
  for (const k of added) delete g[k];
  return caps;
}
