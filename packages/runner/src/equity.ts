// Equity series of an agent (for an equity chart): at most one point per EQUITY_POINT_MIN_GAP_SEC per agent,
// and the next point right after a trade (markDirty).

/** Minimum gap between two recorded equity points (seconds). */
export const EQUITY_POINT_MIN_GAP_SEC = 60;

export type EquitySink = (agentId: number, ts: number, equityUsd: number) => void;

export class EquityRecorder {
  private readonly last = new Map<number, number>();
  private readonly dirty = new Set<number>();
  constructor(private readonly sink?: EquitySink) {}

  /** Returns true when a point was written. */
  record(agentId: number, ts: number, equityUsd: number): boolean {
    if (!this.sink) return false;
    const prev = this.last.get(agentId);
    if (!this.dirty.has(agentId) && prev !== undefined && ts - prev < EQUITY_POINT_MIN_GAP_SEC) return false;
    if (!(equityUsd > 0)) return false;
    this.sink(agentId, ts, equityUsd);
    this.last.set(agentId, ts);
    this.dirty.delete(agentId);
    return true;
  }

  markDirty(agentId: number): void {
    this.dirty.add(agentId);
  }
}
