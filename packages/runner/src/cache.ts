/** TTL cache for expensive reads (on-chain agent record, mids, order books). */
export class TtlCache {
  private readonly m = new Map<string, { v: unknown; exp: number }>();
  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.m.get(key);
    const t = Date.now();
    if (hit && hit.exp > t) return hit.v as T;
    const v = await load();
    this.m.set(key, { v, exp: t + ttlMs });
    return v;
  }
  clear(): void {
    this.m.clear();
  }
}
