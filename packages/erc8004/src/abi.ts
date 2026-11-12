// ABI of the ERC-8004 Identity Registry: only functions verified in the deployed bytecode.
// Robinhood Chain mainnet 4663: proxy 0x8004A169...a432, getVersion() = "2.0.0", with register(), register(string),
// register(string,(string,bytes)[]), ownerOf, tokenURI, getMetadata and transferFrom (the testnet 46630 proxy
// 0x8004A818...BD9e runs the same implementation). The agentURI is set once at registration and points to a stable
// API URL, so setAgentURI is not needed.
import { parseAbi } from "viem";

export const identityRegistryAbi = parseAbi([
  "function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256 agentId)",
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function getVersion() view returns (string)",
  // the id of a new identity is read from the standard ERC-721 Transfer(from = 0): its format does not depend on the registry version
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

/** On-chain metadata keys that point an identity back to its AgentHub record (eip155:<chainId>:<hub>). */
export const METADATA_KEYS = { agentHub: "agentHub", agentHubId: "agentHubId" } as const;
