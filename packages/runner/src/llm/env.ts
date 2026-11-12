// LLM providers from environment variables. No vendor endpoint is hard-coded: any OpenAI-compatible endpoint works.
//
//   LLM_BASE_URL            required, e.g. https://<your-endpoint>/v1
//   LLM_API_KEY             required
//   LLM_PROVIDER_NAME       optional, default "openai-compatible" (must match ModelInfo.provider of your models)
//   LLM_TIMEOUT_MS          optional, default 25000 (the runner walks agents sequentially; a hung model must not delay stops)
//   LLM_FALLBACK_BASE_URL   optional second endpoint used when the first one fails
//   LLM_FALLBACK_API_KEY
//   LLM_FALLBACK_MODEL      model used on the fallback endpoint
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { LlmProvider } from "./types.js";

type Env = Record<string, string | undefined>;

export function loadLlmFromEnv(env: Env = process.env, fetchImpl?: typeof fetch): LlmProvider[] {
  const timeout = Number(env.LLM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeout) && timeout >= 3000 ? Math.min(timeout, 120_000) : 25_000;
  const providers: LlmProvider[] = [];
  const baseUrl = env.LLM_BASE_URL?.trim();
  if (baseUrl) {
    providers.push(
      new OpenAiCompatibleProvider({
        baseUrl,
        apiKey: env.LLM_API_KEY?.trim() || undefined,
        name: env.LLM_PROVIDER_NAME?.trim() || "openai-compatible",
        timeoutMs,
        fetchImpl,
      }),
    );
  }
  const fbUrl = env.LLM_FALLBACK_BASE_URL?.trim();
  if (fbUrl) {
    providers.push(
      new OpenAiCompatibleProvider({
        baseUrl: fbUrl,
        apiKey: env.LLM_FALLBACK_API_KEY?.trim() || undefined,
        name: "fallback",
        defaultModel: env.LLM_FALLBACK_MODEL?.trim() || undefined,
        timeoutMs,
        fetchImpl,
      }),
    );
  }
  return providers;
}
