// LLM provider contracts. The decision layer only needs "complete this prompt as JSON matching this schema".

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompletionRequest {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Per-request timeout (ms) instead of the provider default, for long answers. */
  timeoutMs?: number;
}

export interface LlmCompletion {
  provider: string;
  model: string; // the model that actually answered
  text: string;
  usage: LlmUsage;
}

/** Provider error (network, 4xx/5xx, refusal). `retryable`: whether retrying the same provider makes sense. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** A provider adapter. `name` matches ModelInfo.provider of the models it serves. */
export interface LlmProvider {
  readonly name: string;
  /** Model used when this provider serves as a fallback for a model of another provider. */
  readonly defaultModel?: string;
  available(): boolean;
  complete(req: LlmCompletionRequest): Promise<LlmCompletion>;
  listModels?(): Promise<string[]>;
}
