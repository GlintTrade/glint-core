// zod schemas of tool inputs. The shape matches StrategySpec (./spec.ts).
// Numeric bounds are checked by the backend (validate_strategy); here only the shape and hints for the model.

import { z } from "zod";
import { BUILTIN_PRESETS, LIMITS, type RiskBox, type StrategySpec } from "./spec";

export const RiskBoxSchema = z
  .object({
    maxPositionBps: z.number().int().describe("Max share of account equity held in ONE token, in bps (10000 = 100%). Range 1..10000."),
    maxTradeBps: z.number().int().describe("Max share of equity per single trade, in bps. Range 1..10000."),
    maxDailyLossBps: z.number().int().describe("Daily loss (bps of equity) after which the agent may only sell/protect, no new buys. Range 1..10000."),
    maxTradesPerDay: z.number().int().describe("Max number of trades per day, >= 1."),
    durationDays: z.number().int().describe("How many days the agent runs; 0 = no limit."),
  })
  .describe("Hard risk limits enforced by the deterministic risk engine (not by the AI). All shares are in bps.");

const ParamValueSchema = z.union([z.number(), z.string(), z.boolean(), z.record(z.string(), z.number())]);

export const StrategySpecSchema = z
  .object({
    version: z.literal(1).describe("Spec format version, always 1."),
    preset: z.string().describe(`Preset key from list_presets, e.g. ${BUILTIN_PRESETS.map((p) => JSON.stringify(p.key)).join(", ")}.`),
    name: z.string().describe(`Agent name, 1..${LIMITS.nameMax} chars.`),
    goal: z.string().describe(`Plain-language instruction for the AI trader, up to ${LIMITS.goalMax} chars.`),
    markets: z
      .array(z.string())
      .describe(
        `Spot symbols from list_markets (Lighter pairs SYMBOL/USDG on Robinhood Chain), e.g. ["NVDA","SPY","QQQ"] (1..${LIMITS.marketsMax} items), OR ["*"] alone to trade all liquid pairs.`,
      ),
    quote: z
      .enum(["USDG", "USDC"])
      .describe('Quote currency: "USDG" (Lighter on Robinhood Chain). "USDC" is accepted for compatibility and normalised to USDG.'),
    model: z.string().describe("Model id from list_models (enabled models only; premium tier requires token holding)."),
    intervalSec: z.number().int().describe("Seconds between AI decisions. Default 300. Must be >= platform min (see get_platform_config.intervals)."),
    profile: z.enum(["conservative", "balanced", "aggressive"]).describe("Risk profile; picks preset defaults."),
    risk: RiskBoxSchema,
    params: z
      .record(z.string(), ParamValueSchema)
      .describe("Preset parameters. Keys/types/ranges are defined by the preset's paramsSchema (see list_presets)."),
  })
  .describe("Glint StrategySpec (see the strategy_guide resource / get_strategy_guide tool).");

// Compile-time check that the schema matches the StrategySpec type.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const _specCompat: Equals<z.infer<typeof StrategySpecSchema>, StrategySpec> = true;
const _riskCompat: Equals<z.infer<typeof RiskBoxSchema>, RiskBox> = true;
void _specCompat;
void _riskCompat;

export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

export const IdSchema = z.number().int().positive();
