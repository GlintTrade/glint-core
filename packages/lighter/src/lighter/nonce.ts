// Nonces are per API key (docs: core-concepts#nonce): new_nonce = previous + 1 (we never use skipNonce), and
// transactions on one key are queued by the exchange. All signing + sending on one key is serialised here:
// inside the lock we read nextNonce from the API, sign, send and CONFIRM the result before the next transaction on
// that key starts. So the server's nextNonce is authoritative and two processes never race on our side.
// Rejections that do not consume the nonce (API-level "invalid nonce" 21104) are retried with a fresh nonce.

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Runs fn after every earlier fn with the same key has settled; different keys run in parallel. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** Number of keys with work queued (tests). */
  get size(): number {
    return this.tails.size;
  }
}

export const nonceKey = (accountIndex: number, apiKeyIndex: number) => `${accountIndex}:${apiKeyIndex}`;

let lastClientOrderIndex = 0;
/**
 * Unique client_order_index (uint48, unique across markets per account): ms timestamp × 100 + counter.
 * 1.8e12 ms × 100 ≈ 1.8e14 < 2^48 ≈ 2.8e14 (valid until year 2059). Strictly increasing within the process.
 */
export function newClientOrderIndex(nowMs = Date.now()): number {
  const base = Math.floor(nowMs) * 100;
  lastClientOrderIndex = Math.max(base, lastClientOrderIndex + 1);
  return lastClientOrderIndex;
}
