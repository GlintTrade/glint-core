// StrategySpec validation: structure (zod, no extra keys: they would change the specHash) and
// semantics (preset, markets, model, interval, limits, params against the preset's paramsSchema).
import { z } from "zod";
import { specHashOf } from "./hash.js";
import { ALL_MARKETS, LIMITS } from "./presets.js";
import type { ModelInfo, PresetInfo, PresetParamField, StrategySpec } from "./types.js";

export const MAX_INTERVAL_SEC = 86400;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Risk limits as accepted by the AgentHub contract (uint16 bps 1..10000, uint16 trades, uint32 days). */
export const RiskBoxSchema = z.object({
  maxPositionBps: int(1, 10000),
  maxTradeBps: int(1, 10000),
  maxDailyLossBps: int(1, 10000),
  maxTradesPerDay: int(1, 65535),
  durationDays: int(0, 4294967295),
});

const ParamValue = z.union([z.number().finite(), z.string().max(200), z.boolean(), z.record(z.string(), z.number().finite())]);

export const StrategySpecSchema = z
  .object({
    version: z.literal(1),
    preset: z.string().min(1).max(32),
    name: z.string().trim().min(1).max(LIMITS.nameMax),
    goal: z.string().max(LIMITS.goalMax),
    markets: z.array(z.string().min(1).max(32)).min(1).max(LIMITS.marketsMax),
    // Lighter RH quote is USDG; "USDC" from older clients (the site, MCP) is accepted and normalised
    quote: z.enum(["USDG", "USDC"]).transform(() => "USDG" as const),
    model: z.string().min(1).max(128),
    intervalSec: z.number().int().positive(),
    profile: z.enum(["conservative", "balanced", "aggressive"]),
    risk: RiskBoxSchema.strict(),
    params: z.record(z.string(), ParamValue),
  })
  .strict();

export interface ValidationEnv {
  presets: PresetInfo[];
  marketSymbols: string[]; // tradable symbols (enabled and resolved in spotMeta)
  models: ModelInfo[]; // enabled models
  intervals: { min: number; premiumMin: number };
  isPremium: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  specHash: `0x${string}` | null;
  spec?: StrategySpec;
}

export function validateParam(field: PresetParamField, v: unknown): string | null {
  switch (field.type) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `${field.key}: expected a number`;
      if (field.min !== undefined && v < field.min) return `${field.key}: below the minimum ${field.min}`;
      if (field.max !== undefined && v > field.max) return `${field.key}: above the maximum ${field.max}`;
      return null;
    case "string":
      return typeof v === "string" ? null : `${field.key}: expected a string`;
    case "boolean":
      return typeof v === "boolean" ? null : `${field.key}: expected a boolean`;
    case "select":
      return typeof v === "string" && (field.options ?? []).includes(v) ? null : `${field.key}: allowed values ${(field.options ?? []).join(", ")}`;
    case "weights": {
      // { SYMBOL: bps } target weights: integers 1..10000, sum <= 10000 (the rest stays in USDG)
      if (!v || typeof v !== "object" || Array.isArray(v)) return `${field.key}: expected { SYMBOL: bps }`;
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) return `${field.key}: at least one token is required`;
      let sum = 0;
      for (const [k, x] of entries) {
        if (!/^[A-Za-z0-9]{1,16}$/.test(k)) return `${field.key}: invalid symbol ${k}`;
        if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 10000) return `${field.key}.${k}: expected an integer 1..10000 bps`;
        sum += x;
      }
      if (sum > 10000) return `${field.key}: weights sum to ${sum} bps > 10000`;
      return null;
    }
  }
}

export function validateSpec(raw: unknown, env: ValidationEnv): ValidationResult {
  let specHash: `0x${string}` | null = null;
  try {
    specHash = raw && typeof raw === "object" ? specHashOf(raw) : null;
  } catch {
    specHash = null;
  }
  const parsed = StrategySpecSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`), specHash };
  }
  const spec = parsed.data as StrategySpec;
  specHash = specHashOf(spec); // hash of the normalised spec (quote USDG) — what prepare puts on-chain
  const errors: string[] = [];

  const preset = env.presets.find((p) => p.key === spec.preset);
  if (!preset) errors.push(`preset: unknown preset ${spec.preset}`);
  else if (!preset.enabled) errors.push(`preset: preset ${spec.preset} is disabled`);

  const allowed = new Set(env.marketSymbols);
  const seen = new Set<string>();
  if (spec.markets.includes(ALL_MARKETS)) {
    // "all liquid pairs" mode: ["*"] must be the only element
    if (spec.markets.length !== 1) errors.push(`markets: "${ALL_MARKETS}" (all liquid pairs) must be the only element`);
  } else
    for (const m of spec.markets) {
      if (seen.has(m)) errors.push(`markets: duplicate ${m}`);
      seen.add(m);
      if (!allowed.has(m)) errors.push(`markets: ${m} is not in the whitelist`);
    }

  const model = env.models.find((m) => m.id === spec.model && m.enabled);
  if (!model) errors.push(`model: model ${spec.model} is not available`);
  else if (model.tier === "premium" && !env.isPremium) errors.push(`model: ${spec.model} is available to token holders only (premium)`);

  const minInterval = env.isPremium ? Math.min(env.intervals.min, env.intervals.premiumMin) : env.intervals.min;
  if (spec.intervalSec < minInterval) errors.push(`intervalSec: minimum is ${minInterval}s${env.isPremium ? "" : " (60s is premium only)"}`);
  if (spec.intervalSec > MAX_INTERVAL_SEC) errors.push(`intervalSec: maximum is ${MAX_INTERVAL_SEC}s`);

  if (preset) {
    for (const f of preset.paramsSchema) {
      if (!(f.key in spec.params)) {
        errors.push(`params.${f.key}: required`);
        continue;
      }
      const err = validateParam(f, spec.params[f.key]);
      if (err) errors.push(`params.${err}`);
    }
    // rebalancing: the target tokens are the agent's markets (not the "*" mode)
    const rb = preset.rules?.rebalance;
    if (rb) {
      const t = spec.params[rb.targetsParam];
      if (spec.markets.includes(ALL_MARKETS)) errors.push(`markets: the ${preset.title} preset needs explicit pairs (the target tokens), not all liquid pairs`);
      else if (t && typeof t === "object")
        for (const k of Object.keys(t as Record<string, number>))
          if (!spec.markets.includes(k)) errors.push(`params.${rb.targetsParam}.${k}: the target token must be one of the agent's markets`);
    }
    const maxPosParam = preset.rules?.maxPositionsParam;
    const maxPos = maxPosParam ? spec.params[maxPosParam] : undefined;
    if (typeof maxPos === "number" && (!Number.isInteger(maxPos) || maxPos < 1)) errors.push(`params.${maxPosParam}: expected a positive integer`);
  }
  return { ok: errors.length === 0, errors, specHash, spec };
}
