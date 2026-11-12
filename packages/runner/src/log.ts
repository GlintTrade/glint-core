// Minimal structured logger interface (compatible with pino: log(obj, msg)). Secrets never reach the output.

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const noop = () => {};
export const noopLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/** Keys whose values are always replaced by "[redacted]", at any depth. */
export const REDACT_KEYS = new Set(["privatekey", "masterkey", "walletenc", "apikey", "key", "token", "signature", "authorization", "x-api-key"]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

/** JSON-lines logger on stderr with secret redaction. */
export function consoleLogger(level: LogLevel = "info", name = "glint-runner"): Logger {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl: Exclude<LogLevel, "silent">) => (obj: unknown, msg?: string) => {
    if (LEVELS[lvl] < min) return;
    const base = obj && typeof obj === "object" ? (redact(obj) as Record<string, unknown>) : { value: obj };
    process.stderr.write(`${JSON.stringify({ level: lvl, time: new Date().toISOString(), name, ...base, ...(msg ? { msg } : {}) })}\n`);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
