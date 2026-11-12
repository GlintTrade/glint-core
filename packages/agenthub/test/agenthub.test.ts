import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type Abi, encodeAbiParameters, encodeEventTopics, getAddress, toHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  AGENT_HUB_ADDRESS,
  agentHubAbi,
  batches,
  DisabledHub,
  decodeAgentHubLog,
  decodeTradeRecorded,
  MemoryReceiptSink,
  marketBytes32,
  marketFromBytes32,
  ROBINHOOD_CHAIN_ID,
  SELLER_SHARE_BPS,
  toEpochReceipt,
  toTradeReceipt,
} from "../src/index.js";

const require = createRequire(import.meta.url);

function compileInterface(): Abi {
  // solc-js: compile contracts/IAgentHub.sol and take the ABI of the interface
  const solc = require("solc");
  const source = readFileSync(new URL("../contracts/IAgentHub.sol", import.meta.url), "utf8");
  const input = { language: "Solidity", sources: { "IAgentHub.sol": { content: source } }, settings: { outputSelection: { "*": { "*": ["abi"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  return out.contracts["IAgentHub.sol"].IAgentHub.abi as Abi;
}

type Param = { type: string; name?: string; indexed?: boolean; components?: readonly Param[] };
const param = (p: Param): string => {
  const t = p.components ? `(${p.components.map(param).join(",")})${p.type.slice("tuple".length)}` : p.type;
  return `${t}${p.indexed ? " indexed" : ""}${p.name ? ` ${p.name}` : ""}`;
};
/** Canonical description of every function/event/error: name, typed named params, outputs, mutability. */
const signatures = (abi: Abi) =>
  abi
    .filter((x) => x.type === "function" || x.type === "event" || x.type === "error")
    .map((x) => {
      const i = x as { type: string; name: string; inputs: Param[]; outputs?: Param[]; stateMutability?: string };
      const out = i.outputs ? ` returns (${i.outputs.map(param).join(",")})` : "";
      return `${i.type} ${i.name}(${i.inputs.map(param).join(",")})${i.stateMutability ? ` ${i.stateMutability}` : ""}${out}`;
    })
    .sort();

describe("AgentHub interface", () => {
  it("IAgentHub.sol compiles and matches the TypeScript ABI exactly (functions, events, errors)", () => {
    const sol = compileInterface();
    expect(signatures(agentHubAbi as Abi)).toEqual(signatures(sol));
  });

  it("declares only user-facing and read functions", () => {
    const names = (agentHubAbi as Abi).filter((x) => "name" in x).map((x) => (x as { name: string }).name);
    const functions = (agentHubAbi as Abi).filter((x) => x.type === "function").map((x) => (x as { name: string }).name);
    expect(functions.sort()).toEqual(
      [
        "agentCount",
        "agentsOf",
        "buy",
        "createAgent",
        "createListing",
        "getAgent",
        "getIdentity",
        "getListing",
        "isPremium",
        "listingCount",
        "setAgentIdentity",
        "setAgentStatus",
        "setApiWallet",
        "updateAgent",
        "updateListing",
      ].sort(),
    );
    const events = (agentHubAbi as Abi).filter((x) => x.type === "event").map((x) => (x as { name: string }).name);
    expect(events.sort()).toEqual(
      [
        "AgentCreated",
        "AgentIdentitySet",
        "AgentStatusChanged",
        "AgentUpdated",
        "ApiWalletChanged",
        "EpochRecorded",
        "ListingCreated",
        "ListingUpdated",
        "Purchased",
        "TradeRecorded",
      ].sort(),
    );
    expect(names.length).toBeGreaterThan(functions.length + events.length); // plus the user-facing errors
  });

  it("points at the public mainnet deployment", () => {
    expect(getAddress(AGENT_HUB_ADDRESS)).toBe(AGENT_HUB_ADDRESS);
    expect(AGENT_HUB_ADDRESS).toBe("0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c");
    expect(ROBINHOOD_CHAIN_ID).toBe(4663);
    expect(SELLER_SHARE_BPS).toBe(9800);
  });
});

describe("receipts", () => {
  it("market bytes32 = utf8 right-padded with zeros, and back", () => {
    expect(marketBytes32("NVDA")).toBe(toHex("NVDA", { size: 32 }));
    expect(marketBytes32("NVDA").startsWith("0x4e564441")).toBe(true);
    expect(marketFromBytes32(marketBytes32("TSLA/USDG"))).toBe("TSLA/USDG");
  });

  it("trade receipt: 6-decimal USD, price * 1e8, side 0/1", () => {
    const r = toTradeReceipt({ agentId: 7, side: "sell", market: "NVDA", sizeUsd: 123.4567891, price: 41.23456789, hlOrderId: 99, timestamp: 1_700_000_000 });
    expect(r).toEqual({
      agentId: 7n,
      side: 1,
      market: marketBytes32("NVDA"),
      sizeUsd: 123456789n,
      priceE8: 4123456789n,
      hlOrderId: 99n,
      timestamp: 1_700_000_000n,
    });
    expect(toTradeReceipt({ agentId: 1, side: "buy", market: "X", sizeUsd: 1, price: 1, hlOrderId: 1, timestamp: 1 }).side).toBe(0);
  });

  it("epoch receipt: pnl in bps since activation, clamped to int32", () => {
    expect(toEpochReceipt({ agentId: 1, equityUsd: 110, initialEquityUsd: 100, timestamp: 5 })).toEqual({
      agentId: 1n,
      equityUsd: 110_000_000n,
      pnlBps: 1000,
      timestamp: 5n,
    });
    expect(toEpochReceipt({ agentId: 1, equityUsd: 1e12, initialEquityUsd: 1e-6, timestamp: 5 }).pnlBps).toBe(2_147_483_647);
    expect(toEpochReceipt({ agentId: 1, equityUsd: 5, initialEquityUsd: 0, timestamp: 5 }).pnlBps).toBe(0);
  });

  it("batches never produce an empty batch", () => {
    expect(batches([], 100)).toEqual([]);
    expect(batches([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it("decodes a TradeRecorded log into human units", () => {
    const r = toTradeReceipt({ agentId: 3, side: "buy", market: "NVDA", sizeUsd: 250.5, price: 101234.5, hlOrderId: 42, timestamp: 1_700_000_123 });
    const event = (agentHubAbi as Abi).find((x) => x.type === "event" && x.name === "TradeRecorded")!;
    const topics = encodeEventTopics({ abi: agentHubAbi, eventName: "TradeRecorded", args: { agentId: r.agentId } });
    const nonIndexed = (event as unknown as { inputs: { indexed?: boolean; type: string; name: string }[] }).inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(nonIndexed, [r.side, r.market, r.sizeUsd, r.priceE8, r.hlOrderId, r.timestamp]);
    expect(decodeTradeRecorded({ data, topics: topics as [`0x${string}`, ...`0x${string}`[]] })).toEqual({
      agentId: 3,
      side: "buy",
      market: "NVDA",
      sizeUsd: 250.5,
      price: 101234.5,
      hlOrderId: 42,
      timestamp: 1_700_000_123,
    });
    expect(decodeTradeRecorded({ data: "0x", topics: [] })).toBeNull();
    expect(decodeAgentHubLog({ data, topics: topics as [`0x${string}`, ...`0x${string}`[]] })?.eventName).toBe("TradeRecorded");
    expect(decodeAgentHubLog({ data: "0x", topics: [] })).toBeNull();
  });
});

describe("DisabledHub", () => {
  it("fails loudly on reads, isPremium is false", async () => {
    const h = new DisabledHub();
    expect(h.enabled).toBe(false);
    await expect(h.getAgent()).rejects.toThrow(/not configured/);
    await expect(h.getLogs()).rejects.toThrow();
    expect(await h.isPremium()).toBe(false);
  });
});

describe("MemoryReceiptSink", () => {
  it("keeps receipts and returns distinct hashes", async () => {
    const sink = new MemoryReceiptSink();
    const t = toTradeReceipt({ agentId: 1, side: "buy", market: "NVDA", sizeUsd: 10, price: 100, hlOrderId: 5, timestamp: 1 });
    const h1 = await sink.recordTrades([t]);
    const h2 = await sink.recordEpochs([toEpochReceipt({ agentId: 1, equityUsd: 10, initialEquityUsd: 10, timestamp: 2 })]);
    expect(h1).not.toBe(h2);
    expect(sink.trades).toEqual([t]);
    expect(sink.epochs).toHaveLength(1);
  });
});
