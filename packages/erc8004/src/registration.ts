// Agent registration file per EIP-8004 (type registration-v1) plus an extension section that links the identity
// to the agent's AgentHub record. The section key and its exchange sub-object key are historical names, kept so
// registration files that are already published keep the same shape. The private strategy (goal, params, the name of a purchased copy) is NEVER
// exposed: only public limits and markets, which are visible on the marketplace anyway.
import type { RiskBox } from "@glint/strategy";
import { getAddress } from "viem";
import { agentRegistryId, type Erc8004Config, type Hex } from "./config.js";
import type { IdentityRow } from "./store.js";

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** The agent fields the registration file needs. */
export interface RegistrationAgent {
  id: number;
  owner: Hex;
  locked: boolean; // purchased copy
  chainStatus: number; // AgentHub status: 0 Active, 1 Paused, 2 Stopped
  offchainStatus?: "ok" | "paused" | "stopped" | "killed";
  sourceAgentId: number;
  specHash: Hex;
  intervalSec: number;
  risk: RiskBox;
  apiWallet: Hex;
  /** spec.name; only published for agents that are not locked copies. */
  name?: string;
  markets?: string[];
}

export interface RegistrationContext {
  agent: RegistrationAgent;
  identity?: Pick<IdentityRow, "erc8004Id" | "chainId" | "registry">;
  presetTitle: string;
  presetDescription: string;
  hub: { chainId: number; address: Hex };
  /** AgentHub chain name for the description (default: Robinhood Chain). */
  chainName?: string;
  /** Lighter network of the agent's account. */
  hlNetwork: "mainnet" | "testnet";
  ecfg: Pick<Erc8004Config, "chainId" | "registry" | "publicApiUrl" | "webUrl">;
  appName?: string;
}

const STATUS = ["active", "paused", "stopped"] as const;

export function buildRegistrationFile(ctx: RegistrationContext) {
  const { agent: a, identity, ecfg } = ctx;
  const appName = ctx.appName ?? "glint";
  // name: from the spec for a regular agent; neutral for a purchased (locked) copy (the seller's name stays private)
  const name = !a.locked && a.name ? a.name : `${appName} agent #${a.id}`;
  const status = a.offchainStatus === "killed" || a.offchainStatus === "stopped" ? "stopped" : (STATUS[a.chainStatus] ?? "active");
  const registrations =
    identity && identity.erc8004Id !== null ? [{ agentId: identity.erc8004Id, agentRegistry: agentRegistryId(identity.chainId, identity.registry) }] : [];
  return {
    type: REGISTRATION_TYPE,
    name,
    description:
      `${ctx.presetTitle} spot trading agent on Lighter (Robinhood Chain). ${ctx.presetDescription} ` +
      `Trades from its owner's own Lighter account with a trade-only API key: Glint uses the key only to create orders, ` +
      `cancel and cancel all; withdrawing isn't part of what the agent does. Hard risk limits are recorded in the ` +
      `AgentHub contract on ${ctx.chainName ?? "Robinhood Chain"}, and every trade is written on-chain as a receipt.`,
    image: `${ecfg.webUrl}/favicon.svg`,
    services: [
      { name: "web", endpoint: `${ecfg.webUrl}/account` },
      { name: "api", endpoint: `${ecfg.publicApiUrl}/v1/agents/${a.id}`, version: "v1" },
      { name: "trades", endpoint: `${ecfg.publicApiUrl}/v1/agents/${a.id}/trades`, version: "v1" },
      { name: "MCP", endpoint: `${ecfg.webUrl}/docs`, version: "stdio" },
    ],
    x402Support: false,
    active: status === "active",
    registrations,
    supportedTrust: [] as string[],
    elysium: {
      agentHub: `eip155:${ctx.hub.chainId}:${ctx.hub.address}`,
      agentHubAgentId: a.id,
      owner: getAddress(a.owner),
      preset: ctx.presetTitle,
      locked: a.locked,
      sourceAgentId: a.sourceAgentId || undefined,
      status,
      specHash: a.specHash,
      intervalSec: a.intervalSec,
      risk: a.risk,
      markets: a.markets ?? [],
      hyperliquid: { network: ctx.hlNetwork, apiWallet: getAddress(a.apiWallet) },
    },
  };
}

export type RegistrationFile = ReturnType<typeof buildRegistrationFile>;
