// AI response schema (AgentDecision): zod for validation + JSON Schema for structured outputs.
// The AI response is untrusted input: it is validated, strings are truncated, garbage is an error (the runner holds).
import { type AgentDecision, LIMITS } from "@glint/strategy";
import { z } from "zod";

const ActionSchema = z.object({
  type: z.enum(["buy", "sell", "hold"]),
  market: z.string().max(32).default(""),
  sizeBps: z
    .number()
    .finite()
    .transform((n) => Math.max(0, Math.min(10000, Math.round(n)))),
  limitPriceUsd: z
    .number()
    .finite()
    .positive()
    .nullable()
    .optional()
    .transform((v) => (v === null ? undefined : v)),
  reason: z
    .string()
    .default("")
    .transform((s) => s.slice(0, LIMITS.reasonMax)),
});

export const DecisionSchema = z.object({
  actions: z.array(ActionSchema).max(LIMITS.actionsPerDecisionMax),
  note: z
    .string()
    .default("")
    .transform((s) => s.slice(0, 500)),
});

/** JSON Schema for response_format. No numeric bounds here: zod and the risk engine enforce them. */
export const DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["actions", "note"],
  properties: {
    actions: {
      type: "array",
      description: `0..${LIMITS.actionsPerDecisionMax} actions`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "market", "sizeBps", "limitPriceUsd", "reason"],
        properties: {
          type: { type: "string", enum: ["buy", "sell", "hold"] },
          market: { type: "string", description: "a symbol from the agent's market list" },
          sizeBps: { type: "integer", description: "buy: share of equity in bps; sell: share of the current position in bps" },
          limitPriceUsd: { anyOf: [{ type: "number" }, { type: "null" }], description: "null = aggressive IOC limit capped by max slippage" },
          reason: { type: "string", description: `short explanation in English, up to ${LIMITS.reasonMax} characters` },
        },
      },
    },
    note: { type: "string", description: "brief market summary in English" },
  },
};

export const HOLD_DECISION = (note: string): AgentDecision => ({ actions: [], note });

/** Extracts a JSON object from model text: plain JSON, a ```json block, or the first balanced {...}. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* try the next form */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {
      /* try the next form */
    }
  }
  const start = t.indexOf("{");
  if (start < 0) throw new Error("no JSON object in the response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON object in the response");
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = extractJson(raw);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  const res = schema.safeParse(obj);
  if (!res.success)
    return {
      ok: false,
      error: res.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  return { ok: true, value: res.data };
}

export function parseDecision(raw: unknown): ParseResult<AgentDecision> {
  return parseWith(DecisionSchema as unknown as z.ZodType<AgentDecision>, raw);
}
