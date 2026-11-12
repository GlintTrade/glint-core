// LLM routing for decisions: the provider of the selected model, then another enabled standard model of the same
// provider, then the other providers. An invalid answer gets one retry with the validation error. If everything
// fails the result is `hold` and the runner switches the agent to protect-only mode (no new buys; stops keep working).
import type { AgentDecision, ModelInfo } from "@glint/strategy";
import type { z } from "zod";
import type { Logger } from "../log.js";
import { DECISION_JSON_SCHEMA, HOLD_DECISION, type ParseResult, parseDecision, parseWith } from "./decision.js";
import { buildDecisionPrompt, type DecisionContext } from "./prompt.js";
import { LlmError, type LlmProvider } from "./types.js";

export interface RouterResult<T> {
  ok: boolean;
  value: T;
  provider: string;
  model: string;
  errors: string[];
  /** Set when a backup model answered: the model that was asked first and, in plain words, why it was skipped. */
  fallback?: { from: string; reason: string };
}

/** The decision-feed note when no model answered: the reason in plain words, no provider detail. */
export function aiUnavailableNote(errors: string[]): string {
  const e = errors.join(" ");
  const why = /timeout|timed out|aborted/i.test(e)
    ? "timeout"
    : /invalid response/i.test(e)
      ? "invalid answer"
      : /not set|no AI providers/i.test(e)
        ? "not configured"
        : "provider error";
  return `AI unavailable: ${why}. Held this check; the next check decides normally.`;
}

/** Why the first model was skipped, for people (no provider detail): timeout, invalid answer or unavailable. */
export function fallbackReason(errors: string[]): string {
  const e = errors[0] ?? "";
  if (/timeout|timed out|aborted/i.test(e)) return "did not answer in time";
  if (/invalid response/i.test(e)) return "gave an invalid answer";
  return "was unavailable";
}

export interface UsageRecord {
  ts: number;
  agentId: number | null;
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Where token usage and its cost are recorded (per agent). */
export interface UsageSink {
  recordUsage(u: UsageRecord): void;
}

export interface RouterDeps {
  /** Providers in priority order; the first available one is the default. */
  providers: LlmProvider[];
  /** Platform models (with optional per-1M token prices). */
  models: () => ModelInfo[];
  usage?: UsageSink;
  log?: Logger;
  now?: () => number;
}

export class LlmRouter {
  constructor(private readonly deps: RouterDeps) {}

  private enabledStandard(provider: string, exclude?: string): string | undefined {
    return this.deps.models().find((m) => m.enabled && m.provider === provider && m.tier === "standard" && m.id !== exclude)?.id;
  }

  /** Attempt chain of (provider, model). */
  chain(model: ModelInfo | undefined): { provider: LlmProvider; model: string }[] {
    const providers = this.deps.providers.filter((p) => p.available());
    const out: { provider: LlmProvider; model: string }[] = [];
    const primary = model ? providers.find((p) => p.name === model.provider) : undefined;
    if (primary && model) {
      out.push({ provider: primary, model: model.id });
      // A specific model behind an endpoint can hang while others answer in seconds: try another standard model first.
      const alt = this.enabledStandard(primary.name, model.id);
      if (alt) out.push({ provider: primary, model: alt });
    }
    for (const p of providers) {
      if (p === primary) continue;
      const m = this.enabledStandard(p.name) ?? p.defaultModel;
      if (m) out.push({ provider: p, model: m });
    }
    return out;
  }

  private trackUsage(agentId: number | null, purpose: string, provider: string, model: string, inputTokens: number, outputTokens: number): void {
    if (!this.deps.usage) return;
    const m = this.deps.models().find((x) => x.id === model);
    const costUsd = (inputTokens * (m?.inputPricePer1M ?? 0) + outputTokens * (m?.outputPricePer1M ?? 0)) / 1_000_000;
    const ts = this.deps.now?.() ?? Math.floor(Date.now() / 1000);
    this.deps.usage.recordUsage({ ts, agentId, purpose, provider, model, inputTokens, outputTokens, costUsd });
  }

  async completeJson<T>(args: {
    agentId: number | null;
    purpose: string;
    model?: ModelInfo;
    system: string;
    user: string;
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    parse: (raw: unknown) => ParseResult<T>;
    fallbackValue: T;
    /** Per-attempt limits for long answers (provider defaults otherwise). */
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<RouterResult<T>> {
    const errors: string[] = [];
    const chain = this.chain(args.model);
    for (const [i, { provider, model }] of chain.entries()) {
      let user = args.user;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await provider.complete({
            model,
            system: args.system,
            user,
            schemaName: args.schemaName,
            schema: args.jsonSchema,
            maxTokens: args.maxTokens,
            timeoutMs: args.timeoutMs,
          });
          this.trackUsage(args.agentId, args.purpose, provider.name, res.model, res.usage.inputTokens, res.usage.outputTokens);
          const parsed = args.parse(res.text);
          if (parsed.ok) {
            const first = chain[0]?.model;
            const fallback = i > 0 && first !== undefined && first !== model ? { from: first, reason: fallbackReason(errors) } : undefined;
            return { ok: true, value: parsed.value, provider: provider.name, model: res.model, errors, ...(fallback ? { fallback } : {}) };
          }
          errors.push(`${provider.name}/${model}: invalid response: ${parsed.error}`);
          user = `${args.user}\n\nYour previous answer failed validation (${parsed.error}). Return ONLY valid JSON matching the schema.`;
        } catch (e) {
          const msg = e instanceof LlmError ? e.message : `${provider.name}: ${(e as Error)?.message ?? e}`;
          errors.push(msg);
          break; // provider error: next provider (providers retry 429/503 themselves)
        }
      }
    }
    if (errors.length === 0) errors.push("no AI providers available (set LLM_BASE_URL and LLM_API_KEY)");
    this.deps.log?.warn({ agentId: args.agentId, purpose: args.purpose, errors }, "all AI providers failed");
    return { ok: false, value: args.fallbackValue, provider: "none", model: "none", errors };
  }

  decide(agentId: number, model: ModelInfo | undefined, ctx: DecisionContext): Promise<RouterResult<AgentDecision>> {
    const { system, user } = buildDecisionPrompt(ctx);
    return this.completeJson({
      agentId,
      purpose: "decision",
      model,
      system,
      user,
      schemaName: "agent_decision",
      jsonSchema: DECISION_JSON_SCHEMA,
      parse: parseDecision,
      fallbackValue: HOLD_DECISION("AI unavailable: hold, protect-only mode"),
    });
  }

  generate<T>(
    purpose: string,
    model: ModelInfo | undefined,
    system: string,
    user: string,
    schemaName: string,
    jsonSchema: Record<string, unknown>,
    schema: z.ZodType<T>,
    fallbackValue: T,
  ) {
    return this.completeJson({ agentId: null, purpose, model, system, user, schemaName, jsonSchema, parse: (raw) => parseWith(schema, raw), fallbackValue });
  }
}
