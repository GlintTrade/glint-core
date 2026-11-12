// Trade and epoch receipts: how a filled Lighter order becomes a TradeRecorded event on Robinhood Chain.
//
//   fill on Lighter -> trade row (runner) -> TradeReceipt (this file) -> batched receipt transaction -> TradeRecorded
//   hourly equity snapshot -> EpochReceipt -> batched receipt transaction -> EpochRecorded
//
// Units are fixed-point so the events are exact and cheap: sizeUsd and equityUsd have 6 decimals (like USDG),
// priceE8 = price * 1e8, market = utf8 symbol right-padded to bytes32.
import { decodeEventLog, type Hex, hexToString, type Log, toHex } from "viem";
import { agentHubAbi, SIDE } from "./abi.js";

export interface TradeReceipt {
  agentId: bigint;
  side: number; // 0 buy, 1 sell
  market: Hex; // bytes32
  sizeUsd: bigint; // 6 decimals
  priceE8: bigint;
  hlOrderId: bigint; // Lighter order id (the ABI field name is historical)
  timestamp: bigint;
}

export interface EpochReceipt {
  agentId: bigint;
  equityUsd: bigint; // 6 decimals
  pnlBps: number; // int32
  timestamp: bigint;
}

/** A filled trade as the runner stores it. */
export interface FilledTrade {
  agentId: number;
  side: "buy" | "sell";
  market: string;
  sizeUsd: number;
  price: number;
  hlOrderId: number; // Lighter order id
  timestamp: number; // unix seconds
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** bytes32 market field: utf8 of the symbol, right-padded with zeros (max 32 bytes). */
export const marketBytes32 = (symbol: string): Hex => toHex(symbol, { size: 32 });

/** Inverse of marketBytes32. */
export const marketFromBytes32 = (b: Hex): string => hexToString(b, { size: 32 }).replace(/\0+$/, "");

export function toTradeReceipt(t: FilledTrade): TradeReceipt {
  return {
    agentId: BigInt(t.agentId),
    side: SIDE[t.side],
    market: marketBytes32(t.market),
    sizeUsd: BigInt(Math.round(t.sizeUsd * 1e6)),
    priceE8: BigInt(Math.round(t.price * 1e8)),
    hlOrderId: BigInt(t.hlOrderId),
    timestamp: BigInt(t.timestamp),
  };
}

/** Equity snapshot -> receipt. pnlBps is PnL since activation in bps, clamped to int32. */
export function toEpochReceipt(e: { agentId: number; equityUsd: number; initialEquityUsd: number; timestamp: number }): EpochReceipt {
  const raw = e.initialEquityUsd > 0 ? Math.round(((e.equityUsd - e.initialEquityUsd) / e.initialEquityUsd) * 10000) : 0;
  return {
    agentId: BigInt(e.agentId),
    equityUsd: BigInt(Math.round(e.equityUsd * 1e6)),
    pnlBps: Math.max(INT32_MIN, Math.min(INT32_MAX, raw)),
    timestamp: BigInt(e.timestamp),
  };
}

/** Splits receipts into batches (the contract rejects an empty batch). */
export function batches<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Decodes a TradeRecorded log back into human units (for indexers and auditors). */
export function decodeTradeRecorded(log: Pick<Log, "data" | "topics">): FilledTrade | null {
  try {
    const ev = decodeEventLog({ abi: agentHubAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== "TradeRecorded") return null;
    const a = ev.args;
    return {
      agentId: Number(a.agentId),
      side: a.side === SIDE.sell ? "sell" : "buy",
      market: marketFromBytes32(a.market),
      sizeUsd: Number(a.sizeUsd) / 1e6,
      price: Number(a.priceE8) / 1e8,
      hlOrderId: Number(a.hlOrderId),
      timestamp: Number(a.timestamp),
    };
  } catch {
    return null;
  }
}

/** Any AgentHub event decoded with the public ABI (eventName + args), or null for a foreign or unknown log. */
export function decodeAgentHubLog(log: Pick<Log, "data" | "topics">) {
  try {
    return decodeEventLog({ abi: agentHubAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  } catch {
    return null;
  }
}
