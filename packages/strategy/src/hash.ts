// Hashes that bind the off-chain strategy to the on-chain AgentHub record.
import { keccak256, toBytes } from "viem";
import { canonicalJson } from "./canonical.js";

/** specHash written to AgentHub.createAgent / updateAgent: keccak256 of the canonical JSON of the spec. */
export function specHashOf(spec: unknown): `0x${string}` {
  return keccak256(toBytes(canonicalJson(spec)));
}

/** modelId written to AgentHub: keccak256 of the UTF-8 model id. */
export function modelIdOf(model: string): `0x${string}` {
  return keccak256(toBytes(model));
}
