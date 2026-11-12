// Lighter on Robinhood Chain (docs.lighter.xyz/developers/robinhood-chain/overview) and the factory that wires it.
// Base URL and signing chain id always travel together (RH testnet shares chain id 300 with Lighter testnet).
import { fileURLToPath } from "node:url";
import { LighterClient } from "./lighter/client.js";
import { LighterHttp } from "./lighter/http.js";
import { LighterOnboardingGateway, type OnboardingGateway } from "./lighter/onboarding.js";
import { loadLighterSigner, type SignerFiles } from "./lighter/wasm.js";
import type { ExchangeClient } from "./types.js";

export const LIGHTER_RH = {
  mainnet: { api: "https://api.rh.lighter.xyz", ws: "wss://api.rh.lighter.xyz/stream", chainId: 466324, isTestnet: false },
  testnet: { api: "https://api.rh-testnet.lighter.xyz", ws: "wss://api.rh-testnet.lighter.xyz/stream", chainId: 300, isTestnet: true },
} as const;

/** Upper bound for integrator (partner) spot fees, in millionths (20_000 = 2%). */
export const LIGHTER_MAX_SPOT_FEE = 20_000;

/**
 * Default location of the signer built by scripts/build-lighter-signer.sh: packages/lighter/vendor/lighter-signer/.
 * Resolves the same from src/ and dist/ (both sit one level below the package root).
 */
export function defaultSignerFiles(extraSha256?: string): SignerFiles {
  const file = (name: string) => fileURLToPath(new URL(`../vendor/lighter-signer/${name}`, import.meta.url));
  return { wasmPath: file("lighter-signer.wasm"), wasmExecPath: file("wasm_exec.js"), ...(extraSha256 ? { extraSha256 } : {}) };
}

export interface LighterExchangeOptions {
  /** REST base URL, e.g. LIGHTER_RH.mainnet.api. */
  api: string;
  /** Signing chain id that belongs to `api`, e.g. LIGHTER_RH.mainnet.chainId. */
  chainId: number;
  isTestnet: boolean;
  /** Optional read-only token of the platform account for public reads (rate-limit budget). */
  readToken?: string;
  /** Integrator (partner) account index for fee attribution; null for none. */
  integratorAccountIndex: number | null;
  /** WASM signer files; defaults to defaultSignerFiles(). */
  signer?: SignerFiles;
}

/**
 * One REST transport, one WASM signer (loaded lazily, sha256-pinned), split into the agent capability (orders) for
 * the client and the onboarding capability for the onboarding gateway.
 */
export function createExchange(o: LighterExchangeOptions): { exchange: ExchangeClient; onboarding: OnboardingGateway } {
  const http = new LighterHttp({ baseUrl: o.api, readToken: o.readToken });
  const files = o.signer ?? defaultSignerFiles();
  const signer = () => loadLighterSigner(files);
  const exchange = new LighterClient({
    http,
    chainId: o.chainId,
    isTestnet: o.isTestnet,
    integratorAccountIndex: o.integratorAccountIndex,
    agentWasm: async () => (await signer()).agent,
  });
  const onboarding = new LighterOnboardingGateway({ http, chainId: o.chainId, wasm: async () => (await signer()).onboarding });
  return { exchange, onboarding };
}
