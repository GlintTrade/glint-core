// Human-readable ABI of the public AgentHub surface. Kept in sync with contracts/IAgentHub.sol by a test that
// compiles the interface with solc and compares both ABIs.
import { parseAbi } from "viem";

const RISK = "(uint16 maxPositionBps, uint16 maxTradeBps, uint16 maxDailyLossBps, uint16 maxTradesPerDay, uint32 durationDays)";
const AGENT = `(address owner, uint8 preset, bool locked, uint8 status, uint32 intervalSec, uint64 createdAt, uint256 sourceAgentId, bytes32 specHash, bytes32 modelId, address hlAccount, address apiWallet, ${RISK} risk)`;
const LISTING = "(uint256 agentId, address seller, address payToken, uint256 price, bool active, uint32 sales)";

export const AGENT_HUB_ABI = [
  // ---------- agents ----------
  "function agentCount() view returns (uint256)",
  `function getAgent(uint256 agentId) view returns (${AGENT})`,
  "function agentsOf(address owner) view returns (uint256[])",
  "function isPremium(address user) view returns (bool)",
  `function createAgent(uint8 preset, bytes32 specHash, bytes32 modelId, uint32 intervalSec, address hlAccount, address apiWallet, ${RISK} risk) returns (uint256 agentId)`,
  `function updateAgent(uint256 agentId, bytes32 specHash, bytes32 modelId, uint32 intervalSec, ${RISK} risk)`,
  "function setAgentStatus(uint256 agentId, uint8 status)",
  "function setApiWallet(uint256 agentId, address apiWallet)",

  // ---------- ERC-8004 identity link ----------
  "function getIdentity(uint256 agentId) view returns (uint256 chainId, address registry, uint256 erc8004Id)",
  "function setAgentIdentity(uint256 agentId, uint256 chainId, address registry, uint256 erc8004Id)",

  // ---------- marketplace ----------
  "function listingCount() view returns (uint256)",
  `function getListing(uint256 listingId) view returns (${LISTING})`,
  "function createListing(uint256 agentId, address payToken, uint256 price) returns (uint256 listingId)",
  "function updateListing(uint256 listingId, uint256 price, bool active)",
  "function buy(uint256 listingId, bytes32 expectedSpecHash, address hlAccount, address apiWallet) payable returns (uint256 agentId)",

  // ---------- events ----------
  "event AgentCreated(uint256 indexed agentId, address indexed owner, uint8 preset, bytes32 specHash, uint256 sourceAgentId, bool locked)",
  "event AgentUpdated(uint256 indexed agentId, bytes32 specHash, bytes32 modelId, uint32 intervalSec)",
  "event AgentStatusChanged(uint256 indexed agentId, uint8 status)",
  "event ApiWalletChanged(uint256 indexed agentId, address apiWallet)",
  "event AgentIdentitySet(uint256 indexed agentId, uint256 chainId, address registry, uint256 erc8004Id)",
  "event ListingCreated(uint256 indexed listingId, uint256 indexed agentId, address indexed seller, address payToken, uint256 price)",
  "event ListingUpdated(uint256 indexed listingId, uint256 price, bool active)",
  "event Purchased(uint256 indexed listingId, uint256 indexed newAgentId, address indexed buyer, address payToken, uint256 price, uint256 platformFee)",
  "event TradeRecorded(uint256 indexed agentId, uint8 side, bytes32 market, uint128 sizeUsd, uint128 priceE8, uint64 hlOrderId, uint64 timestamp)",
  "event EpochRecorded(uint256 indexed agentId, uint128 equityUsd, int32 pnlBps, uint64 timestamp)",

  // ---------- errors ----------
  "error ZeroAddress()",
  "error NotAgentOwner()",
  "error PresetNotFound(uint8 presetId)",
  "error PresetDisabled(uint8 presetId)",
  "error InvalidSpecHash()",
  "error IntervalTooShort(uint32 intervalSec, uint256 minIntervalSec)",
  "error InvalidRisk()",
  "error InvalidStatus(uint8 status)",
  "error AgentNotFound(uint256 agentId)",
  "error AgentLocked(uint256 agentId)",
  "error AgentIsStopped(uint256 agentId)",
  "error AgentTooYoung(uint256 agentId, uint256 readyAt)",
  "error ListingNotFound(uint256 listingId)",
  "error ListingInactive(uint256 listingId)",
  "error NotSeller()",
  "error InvalidPrice()",
  "error PayTokenNotAllowed(address token)",
  "error SelfPurchase()",
  "error SpecChanged()",
  "error AgentListed()",
  "error WrongMsgValue(uint256 expected, uint256 actual)",
  "error NativeTransferFailed(address to, uint256 amount)",
] as const;

export const agentHubAbi = parseAbi(AGENT_HUB_ABI);

/** On-chain agent status. */
export const AGENT_STATUS = { Active: 0, Paused: 1, Stopped: 2 } as const;
export type AgentStatus = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];

/** Trade side in receipts. */
export const SIDE = { buy: 0, sell: 1 } as const;

/** Share of a marketplace sale that goes to the seller, in bps (the marketplace keeps 2%). */
export const SELLER_SHARE_BPS = 9800;
