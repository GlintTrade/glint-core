// HTTP transport for the Lighter REST API (https://api.rh.lighter.xyz, prefix /api/v1/).
//
// Rate limits (docs: reference/rate-limits, robinhood-chain/overview): unauthenticated requests share the server IP
// budget (Standard: 60 requests/min). Authenticated requests count against the token's L1 address instead, so:
//  • account-specific reads use the agent's own short auth token (each user has their own budget);
//  • public market data uses LIGHTER_READ_TOKEN when configured (a read-only `ro:` token of the platform account,
//    created once with tokens/create on a Plus/Builder account), otherwise the IP budget.
// Auth tokens are only ever attached to GET requests on AUTH_GET_PATHS: an agent token is never sent to an endpoint
// that changes anything (changeAccountTier, tokens/create, referral, ...). sendTx needs no auth.
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** GET endpoints an auth token may be attached to. */
export const AUTH_GET_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/accountLimits",
  "/api/v1/accountOrders",
  "/api/v1/accountActiveOrders",
  "/api/v1/accountInactiveOrders",
  "/api/v1/trades",
  // public endpoints, authenticated only to move them to the L1 budget
  "/api/v1/account",
  "/api/v1/accountsByL1Address",
  "/api/v1/apikeys",
  "/api/v1/nextNonce",
  "/api/v1/orderBookDetails",
  "/api/v1/orderBookOrders",
  "/api/v1/candles",
  "/api/v1/tx",
]);

export class LighterApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export interface LighterHttpOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Platform read-only token for public reads (optional). */
  readToken?: string;
  /** Sleep for retries (tests: no delay). */
  sleep?: (ms: number) => Promise<void>;
}

export class LighterHttp {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LighterHttpOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * GET /api/v1/<path>. `auth`: an agent auth token (account reads) or "platform" (read token, if any).
   * Retries 429/5xx twice with backoff. Throws LighterApiError on a non-200 `code`.
   */
  async get<T = any>(path: string, params: Record<string, string | number | boolean | undefined>, auth?: string | "platform"): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    const platform = auth === "platform";
    const token = platform ? (this.platformTokenRejected.has(path) ? undefined : this.opts.readToken) : auth;
    if (token) {
      if (!AUTH_GET_PATHS.has(path)) throw new Error(`refusing to send an auth token to ${path}`);
      headers.authorization = token;
    }
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ""}`;
    try {
      return await this.request<T>(url, { method: "GET", headers });
    } catch (e) {
      // the platform token is only a rate-limit optimisation: if an endpoint refuses it (20013 invalid auth, 401/403),
      // read without it from now on rather than fail
      if (platform && token && e instanceof LighterApiError && (e.code === 20013 || e.httpStatus === 401 || e.httpStatus === 403)) {
        this.platformTokenRejected.add(path);
        delete headers.authorization;
        return this.request<T>(url, { method: "GET", headers });
      }
      throw e;
    }
  }

  private readonly platformTokenRejected = new Set<string>();

  /** POST form-encoded (sendTx, changeAccountTier). Callers own the allowlist of what they send. */
  async postForm<T = any>(path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<T> {
    return this.request<T>(
      `${this.base}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
        body: new URLSearchParams(form).toString(),
      },
      false,
    );
  }

  private async request<T>(url: string, init: { method: string; headers: Record<string, string>; body?: string }, retry = true): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
      if (attempt > 0) await this.sleep(500 * 2 ** attempt);
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status === 429 || res.status === 405 || res.status >= 500) {
        lastErr = new LighterApiError(res.status === 429 ? 23000 : res.status, `Lighter HTTP ${res.status}`, res.status);
        continue;
      }
      let body: any;
      try {
        body = await res.json();
      } catch {
        throw new LighterApiError(res.status, `Lighter HTTP ${res.status}: not JSON`, res.status);
      }
      const code = typeof body?.code === "number" ? body.code : res.ok ? 200 : res.status;
      if (code !== 200) throw new LighterApiError(code, `Lighter ${code}: ${String(body?.message ?? "error")}`, res.status);
      return body as T;
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
