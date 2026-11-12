import type { ModelInfo } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { DECISION_JSON_SCHEMA } from "../src/llm/decision.js";
import { loadLlmFromEnv } from "../src/llm/env.js";
import { OpenAiCompatibleProvider } from "../src/llm/openai-compatible.js";
import { aiUnavailableNote, fallbackReason, LlmRouter, type UsageRecord } from "../src/llm/router.js";
import { LlmError } from "../src/llm/types.js";
import { FakeProvider, MODELS } from "./helpers.js";

const req = { model: "m1", system: "sys", user: "usr", schemaName: "agent_decision", schema: DECISION_JSON_SCHEMA };
const okBody = (content: string) => ({ model: "m1", choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });

function fakeFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[], seen: { url: string; init: RequestInit }[]) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
}

describe("OpenAI-compatible provider", () => {
  it("json_schema response format + Bearer key", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const p = new OpenAiCompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://llm.example/v1/",
      fetchImpl: fakeFetch([{ status: 200, body: okBody('{"actions":[],"note":"x"}') }], seen),
    });
    const r = await p.complete(req);
    expect(r).toMatchObject({ provider: "openai-compatible", text: '{"actions":[],"note":"x"}', usage: { inputTokens: 100, outputTokens: 20 } });
    expect(seen[0]!.url).toBe("https://llm.example/v1/chat/completions");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.response_format.type).toBe("json_schema");
    expect(body.messages[1].content).toBe("usr");
  });

  it("400 on json_schema -> retry with an instruction and no response_format (and remember the model)", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const p = new OpenAiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://llm.example/v1",
      fetchImpl: fakeFetch(
        [
          { status: 400, body: { error: "unsupported" } },
          { status: 200, body: okBody("{}") },
          { status: 200, body: okBody("{}") },
        ],
        seen,
      ),
    });
    await p.complete(req);
    const second = JSON.parse(String(seen[1]!.init.body));
    expect(second.response_format).toBeUndefined();
    expect(second.messages[0].content).toContain("JSON Schema");
    await p.complete(req);
    expect(JSON.parse(String(seen[2]!.init.body)).response_format).toBeUndefined();
  });

  it("429/503 -> backoff retries, then success; without a key the provider is unavailable", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const p = new OpenAiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://llm.example/v1",
      baseDelayMs: 1,
      fetchImpl: fakeFetch([{ status: 429 }, { status: 503 }, { status: 200, body: okBody("{}") }], seen),
    });
    await p.complete(req);
    expect(seen).toHaveLength(3);
    const off = new OpenAiCompatibleProvider({ baseUrl: "https://llm.example/v1" });
    expect(off.available()).toBe(false);
    await expect(off.complete(req)).rejects.toBeInstanceOf(LlmError);
  });

  it("model catalog via /models", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const p = new OpenAiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://llm.example/v1",
      fetchImpl: fakeFetch([{ status: 200, body: { data: [{ id: "b" }, { id: "a" }] } }], seen),
    });
    expect(await p.listModels()).toEqual(["a", "b"]);
    expect(seen[0]!.url).toBe("https://llm.example/v1/models");
  });

  it("loadLlmFromEnv: no endpoint configured -> no providers; primary and fallback from env", () => {
    expect(loadLlmFromEnv({})).toEqual([]);
    const ps = loadLlmFromEnv({
      LLM_BASE_URL: "https://a.example/v1",
      LLM_API_KEY: "k",
      LLM_FALLBACK_BASE_URL: "https://b.example/v1",
      LLM_FALLBACK_API_KEY: "k2",
      LLM_FALLBACK_MODEL: "fb",
    });
    expect(ps.map((p) => [p.name, p.available(), p.defaultModel])).toEqual([
      ["openai-compatible", true, undefined],
      ["fallback", true, "fb"],
    ]);
  });
});

describe("LlmRouter", () => {
  const router = (providers: FakeProvider[], usage?: UsageRecord[]) =>
    new LlmRouter({ providers, models: () => MODELS, usage: usage ? { recordUsage: (u) => void usage.push(u) } : undefined });
  const json = { schemaName: "d", jsonSchema: {}, parse: (raw: unknown) => ({ ok: true as const, value: raw }), fallbackValue: null };
  const modelA = MODELS[0]!;

  it("the primary fails -> the fallback provider with its default model; cost is tracked per agent", async () => {
    const primary = new FakeProvider("primary", [new LlmError("x", "primary"), new LlmError("y", "primary")]);
    const fallback = new FakeProvider("fallback", ['{"actions":[],"note":"fb"}'], true, "fallback-model");
    const usage: UsageRecord[] = [];
    const r = await router([primary, fallback], usage).completeJson({ agentId: 5, purpose: "decision", model: modelA, system: "s", user: "u", ...json });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("fallback");
    expect(fallback.calls[0]!.model).toBe("fallback-model");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ agentId: 5, provider: "fallback", inputTokens: 1000, outputTokens: 200, costUsd: 0 });
  });

  it("a hung model -> another standard model of the same provider is tried before other providers", async () => {
    const primary = new FakeProvider("primary", [new LlmError("primary: The operation was aborted due to timeout", "primary"), '{"actions":[],"note":"alt"}']);
    const fallback = new FakeProvider("fallback", [], false);
    const usage: UsageRecord[] = [];
    const r = await router([primary, fallback], usage).completeJson({ agentId: 7, purpose: "decision", model: modelA, system: "s", user: "u", ...json });
    expect(r.ok).toBe(true);
    expect(primary.calls.map((c) => c.model)).toEqual(["model-a", "model-b"]);
    expect(r.model).toBe("model-b");
    // model-b: $0.1 in / $0.2 out per 1M
    expect(usage[0]!.costUsd).toBeCloseTo((1000 * 0.1 + 200 * 0.2) / 1e6, 12);
  });

  it("a model of an unavailable provider -> the first standard model of the next provider", async () => {
    const other: ModelInfo = { id: "other-model", label: "Other", provider: "other", tier: "premium", enabled: true };
    const primary = new FakeProvider("primary", ['{"actions":[],"note":""}']);
    const r = await router([primary]).decide(1, other, {
      preset: { key: "dca", promptTemplate: "x {{goal}}", allowsBuy: true, allowsSell: false },
      goal: "g",
      risk: { maxPositionBps: 1, maxTradeBps: 1, maxDailyLossBps: 1, maxTradesPerDay: 1, durationDays: 0 },
      params: {},
      markets: [],
      usdcBps: 10000,
      dailyPnlBps: 0,
      tradesToday: 0,
      protectOnly: false,
      secondsSinceLastTrade: null,
      nowIso: "t",
    });
    expect(r.ok).toBe(true);
    expect(primary.calls[0]!.model).toBe("model-a");
  });

  it("no provider at all -> fallbackValue and ok=false", async () => {
    const r = await router([]).completeJson({
      agentId: null,
      purpose: "p",
      system: "",
      user: "",
      schemaName: "x",
      jsonSchema: {},
      parse: () => ({ ok: false, error: "x" }),
      fallbackValue: 42,
    });
    expect(r).toMatchObject({ ok: false, value: 42, provider: "none" });
    expect(r.errors[0]).toMatch(/no AI providers/);
  });

  it("a backup model answer carries which model was asked first and why it was skipped", async () => {
    const primary = new FakeProvider("primary", [new LlmError("primary: timeout after 25000 ms", "primary", true), '{"actions":[],"note":"alt"}']);
    const r = await router([primary]).completeJson({ agentId: 1, purpose: "decision", model: modelA, system: "s", user: "u", ...json });
    expect(r.ok).toBe(true);
    expect(r.fallback).toEqual({ from: "model-a", reason: "did not answer in time" });
  });

  it("per-request maxTokens and timeoutMs reach the provider", async () => {
    const primary = new FakeProvider("primary", ['{"x":1}']);
    await router([primary]).completeJson({ agentId: null, purpose: "p", model: modelA, system: "s", user: "u", ...json, maxTokens: 4000, timeoutMs: 45_000 });
    expect(primary.calls[0]).toMatchObject({ maxTokens: 4000, timeoutMs: 45_000 });
  });
});

describe("plain-language AI status for the decision feed", () => {
  it("aiUnavailableNote and fallbackReason name the cause without provider detail", () => {
    expect(aiUnavailableNote(["primary: timeout after 25000 ms"])).toMatch(/^AI unavailable: timeout\./);
    expect(aiUnavailableNote(["primary/model-a: invalid response: x"])).toMatch(/invalid answer/);
    expect(aiUnavailableNote(["no AI providers available (set LLM_BASE_URL and LLM_API_KEY)"])).toMatch(/not configured/);
    expect(aiUnavailableNote(["primary HTTP 500: boom"])).toMatch(/provider error/);
    expect(fallbackReason(["primary/model-a: invalid response: x"])).toBe("gave an invalid answer");
    expect(fallbackReason(["primary HTTP 502"])).toBe("was unavailable");
  });

  it("a hung request times out fast instead of being retried", async () => {
    let calls = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls++;
      return await new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
      });
    }) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ apiKey: "k", baseUrl: "https://llm.example/v1", fetchImpl, timeoutMs: 50, baseDelayMs: 1 });
    await expect(p.complete(req)).rejects.toThrow(/timeout after 50 ms/);
    expect(calls).toBe(1);
  });
});
