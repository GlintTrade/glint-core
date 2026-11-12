// Generic OpenAI-compatible chat completions provider (any endpoint exposing POST {baseUrl}/chat/completions).
// The request may be served by a third party, so the prompt never contains addresses or absolute amounts
// (buildDecisionPrompt guarantees that).
import { type LlmCompletion, type LlmCompletionRequest, LlmError, type LlmProvider } from "./types.js";

export interface OpenAiCompatibleOptions {
  baseUrl: string; // e.g. https://<your-endpoint>/v1 (no trailing slash needed)
  apiKey?: string;
  /** Name that ModelInfo.provider uses for models served by this endpoint. */
  name?: string;
  /** Model to use when this provider acts as a fallback for a model of another provider. */
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  temperature?: number;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly defaultModel?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** Models that rejected response_format json_schema: from then on JSON is requested by instruction. */
  private readonly noSchemaModels = new Set<string>();

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.name = opts.name ?? "openai-compatible";
    this.defaultModel = opts.defaultModel;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  available(): boolean {
    return !!this.opts.apiKey && !!this.baseUrl;
  }

  private async request(path: string, init: RequestInit, timeoutMs = this.opts.timeoutMs ?? 60_000): Promise<Response> {
    const maxRetries = this.opts.maxRetries ?? 3;
    const base = this.opts.baseDelayMs ?? 500;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!RETRY_STATUSES.has(res.status) || attempt === maxRetries) return res;
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : base * 2 ** attempt);
      } catch (e) {
        lastErr = e;
        // a model that did not answer within timeoutMs is hanging: the router moves on to the next model at once
        // instead of waiting for it maxRetries more times
        if ((e as Error)?.name === "TimeoutError") throw new LlmError(`${this.name}: timeout after ${timeoutMs} ms`, this.name, true);
        if (attempt === maxRetries) break;
        await sleep(base * 2 ** attempt);
      }
    }
    throw new LlmError(`${this.name}: network error (${(lastErr as Error)?.message ?? "unknown"})`, this.name, true);
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletion> {
    if (!this.available()) throw new LlmError(`${this.name}: API key is not set`, this.name);
    const useSchema = !this.noSchemaModels.has(req.model);
    let res = await this.post(req, useSchema);
    if (useSchema && res.status === 400) {
      // the model does not support json_schema: retry with an instruction and parse the text
      this.noSchemaModels.add(req.model);
      res = await this.post(req, false);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LlmError(`${this.name} HTTP ${res.status}: ${body.slice(0, 200)}`, this.name, RETRY_STATUSES.has(res.status), res.status);
    }
    // biome-ignore lint/suspicious/noExplicitAny: untyped provider response
    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim() === "") throw new LlmError(`${this.name}: empty response`, this.name, true);
    return {
      provider: this.name,
      model: typeof data.model === "string" ? data.model : req.model,
      text,
      usage: { inputTokens: Number(data?.usage?.prompt_tokens ?? 0), outputTokens: Number(data?.usage?.completion_tokens ?? 0) },
    };
  }

  private post(req: LlmCompletionRequest, withSchema: boolean): Promise<Response> {
    const system = withSchema
      ? req.system
      : `${req.system}\n\nReply with ONLY one JSON object, no explanations or markdown, strictly matching this JSON Schema:\n${JSON.stringify(req.schema)}`;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: req.user },
      ],
      temperature: this.opts.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 1500,
    };
    if (withSchema) body.response_format = { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema, strict: true } };
    return this.request("/chat/completions", { method: "POST", body: JSON.stringify(body) }, req.timeoutMs);
  }

  async listModels(): Promise<string[]> {
    if (!this.available()) return [];
    const res = await this.request("/models", { method: "GET" });
    if (!res.ok) throw new LlmError(`${this.name} /models HTTP ${res.status}`, this.name, false, res.status);
    // biome-ignore lint/suspicious/noExplicitAny: untyped provider response
    const data = (await res.json()) as any;
    const list: unknown[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return list
      .map((m) => (typeof m === "string" ? m : (m as { id?: unknown } | null)?.id))
      .filter((x): x is string => typeof x === "string")
      .sort();
  }
}
