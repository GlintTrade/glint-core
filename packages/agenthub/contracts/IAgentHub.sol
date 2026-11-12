// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title IAgentHub
 * @notice Public interface of the Glint AgentHub contract on Robinhood Chain mainnet (chain id 4663),
 *         deployed at 0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c.
 *
 *         AgentHub is the on-chain registry of trading agents and their marketplace:
 *         - an agent record binds an owner, a strategy hash (specHash), an AI model id, the owner's
 *           Lighter account and the agent's trade-only API key to hard risk limits;
 *         - a listing sells LOCKED copies of an agent: the buyer gets a new agent with the same specHash
 *           and risk limits that can never be changed; the seller receives 98% of the price;
 *         - every trade and periodic equity snapshot is published as an event receipt (TradeRecorded,
 *           EpochRecorded) so anyone can audit an agent's history.
 *
 *         Field names `hlAccount`, `apiWallet` and `hlOrderId` are historical and kept for a stable ABI:
 *         on Glint they hold the owner's Lighter account address, the address derived from the agent's
 *         Lighter API public key, and the Lighter order id.
 *
 *         This file declares only the user-facing functions, the read functions and the events a client or an
 *         auditor needs. Platform configuration and maintenance are intentionally not part of this interface.
 */
interface IAgentHub {
    // ---------------------------------------------------------------------
    //                                Types
    // ---------------------------------------------------------------------

    /// @notice Risk limits of an agent. Shares are in bps (1/10000).
    struct RiskBox {
        uint16 maxPositionBps; // max share of equity in one token
        uint16 maxTradeBps; // max share of equity per trade
        uint16 maxDailyLossBps; // past this daily loss: sells only
        uint16 maxTradesPerDay;
        uint32 durationDays; // 0 = no end date
    }

    /// @notice status: 0 = Active, 1 = Paused, 2 = Stopped (final).
    struct Agent {
        address owner;
        uint8 preset;
        bool locked; // a purchased copy: specHash, model and risk can never change
        uint8 status;
        uint32 intervalSec; // seconds between AI decisions
        uint64 createdAt;
        uint256 sourceAgentId; // for a purchased copy: the listed agent it was copied from
        bytes32 specHash; // keccak256(canonical JSON of the strategy spec)
        bytes32 modelId; // keccak256(utf8(model id))
        address hlAccount; // the owner's Lighter account (funds never leave it)
        address apiWallet; // address of the agent's Lighter API key (used only to create orders, cancel and cancel all)
        RiskBox risk;
    }

    /// @notice payToken = address(0) means native ETH.
    struct Listing {
        uint256 agentId;
        address seller;
        address payToken;
        uint256 price;
        bool active;
        uint32 sales;
    }

    // ---------------------------------------------------------------------
    //                                Events
    // ---------------------------------------------------------------------

    event AgentCreated(
        uint256 indexed agentId, address indexed owner, uint8 preset, bytes32 specHash, uint256 sourceAgentId, bool locked
    );
    event AgentUpdated(uint256 indexed agentId, bytes32 specHash, bytes32 modelId, uint32 intervalSec);
    event AgentStatusChanged(uint256 indexed agentId, uint8 status);
    event ApiWalletChanged(uint256 indexed agentId, address apiWallet);
    event AgentIdentitySet(uint256 indexed agentId, uint256 chainId, address registry, uint256 erc8004Id);

    event ListingCreated(
        uint256 indexed listingId, uint256 indexed agentId, address indexed seller, address payToken, uint256 price
    );
    event ListingUpdated(uint256 indexed listingId, uint256 price, bool active);
    /// @notice platformFee is the marketplace share of the price (2%); the seller receives the rest.
    event Purchased(
        uint256 indexed listingId,
        uint256 indexed newAgentId,
        address indexed buyer,
        address payToken,
        uint256 price,
        uint256 platformFee
    );

    /// @notice Trade receipt. side: 0 = buy, 1 = sell. sizeUsd has 6 decimals, priceE8 = price * 1e8,
    ///         hlOrderId = Lighter order id (cross-check against the account's public trades).
    event TradeRecorded(
        uint256 indexed agentId,
        uint8 side,
        bytes32 market,
        uint128 sizeUsd,
        uint128 priceE8,
        uint64 hlOrderId,
        uint64 timestamp
    );
    /// @notice Periodic equity snapshot. equityUsd has 6 decimals, pnlBps is PnL since activation.
    event EpochRecorded(uint256 indexed agentId, uint128 equityUsd, int32 pnlBps, uint64 timestamp);

    // ---------------------------------------------------------------------
    //                                Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error NotAgentOwner();
    error PresetNotFound(uint8 presetId);
    error PresetDisabled(uint8 presetId);
    error InvalidSpecHash();
    error IntervalTooShort(uint32 intervalSec, uint256 minIntervalSec);
    error InvalidRisk();
    error InvalidStatus(uint8 status);
    error AgentNotFound(uint256 agentId);
    error AgentLocked(uint256 agentId);
    error AgentIsStopped(uint256 agentId);
    error AgentTooYoung(uint256 agentId, uint256 readyAt);
    error ListingNotFound(uint256 listingId);
    error ListingInactive(uint256 listingId);
    error NotSeller();
    error InvalidPrice();
    error PayTokenNotAllowed(address token);
    error SelfPurchase();
    error SpecChanged();
    error AgentListed();
    error WrongMsgValue(uint256 expected, uint256 actual);
    error NativeTransferFailed(address to, uint256 amount);

    // ---------------------------------------------------------------------
    //                                Agents
    // ---------------------------------------------------------------------

    function agentCount() external view returns (uint256);

    /// @notice Reverts AgentNotFound if the agent does not exist.
    function getAgent(uint256 agentId) external view returns (Agent memory);

    function agentsOf(address owner) external view returns (uint256[] memory);

    /// @notice Whether `user` qualifies for premium features (shorter decision intervals).
    function isPremium(address user) external view returns (bool);

    /// @notice Create an agent owned by msg.sender: status Active, not locked.
    function createAgent(
        uint8 preset,
        bytes32 specHash,
        bytes32 modelId,
        uint32 intervalSec,
        address hlAccount,
        address apiWallet,
        RiskBox calldata risk
    ) external returns (uint256 agentId);

    /// @notice Agent owner only; not for locked or stopped agents, and not while the agent has an active listing.
    function updateAgent(uint256 agentId, bytes32 specHash, bytes32 modelId, uint32 intervalSec, RiskBox calldata risk)
        external;

    /// @notice Agent owner only. Active <-> Paused; any -> Stopped (final).
    function setAgentStatus(uint256 agentId, uint8 status) external;

    /// @notice Replace the agent's API key address after a key rotation: the agent owner, or the platform's runner
    ///         when it rotates the key on the owner's behalf. Other callers revert.
    function setApiWallet(uint256 agentId, address apiWallet) external;

    // ---------------------------------------------------------------------
    //                         ERC-8004 identity link
    // ---------------------------------------------------------------------

    /// @notice ERC-8004 identity of the agent (zeros if not set).
    function getIdentity(uint256 agentId) external view returns (uint256 chainId, address registry, uint256 erc8004Id);

    /// @notice Link the agent to its ERC-8004 identity: the agent owner, or the platform's identity job. Other callers revert.
    function setAgentIdentity(uint256 agentId, uint256 chainId, address registry, uint256 erc8004Id) external;

    // ---------------------------------------------------------------------
    //                              Marketplace
    // ---------------------------------------------------------------------

    function listingCount() external view returns (uint256);

    /// @notice Reverts ListingNotFound if the listing does not exist.
    function getListing(uint256 listingId) external view returns (Listing memory);

    /// @notice List copies of an agent for sale. Agent owner only; the agent must be old enough and not locked or stopped.
    function createListing(uint256 agentId, address payToken, uint256 price) external returns (uint256 listingId);

    /// @notice Seller only. Deactivating the last active listing unlocks updateAgent.
    function updateListing(uint256 listingId, uint256 price, bool active) external;

    /**
     * @notice Buy a locked copy of the listed agent for the buyer's own Lighter account.
     * @param expectedSpecHash the specHash the buyer reviewed; reverts SpecChanged if the seller changed the strategy
     * @param hlAccount the buyer's Lighter account address
     * @param apiWallet the API key address of the new agent
     */
    function buy(uint256 listingId, bytes32 expectedSpecHash, address hlAccount, address apiWallet)
        external
        payable
        returns (uint256 agentId);
}
