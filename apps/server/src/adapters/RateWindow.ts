const PRUNE_THRESHOLD = 1_000;

/**
 * Small in-memory sliding window. The server is a single-process local app (Docker or the
 * desktop app), so a shared store would add a dependency without value.
 */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    /**
     * Maximum number of tracked keys. Once the map is full and the expired entries are
     * discarded, a new key is refused: the caller must treat that as a failure (fail
     * closed) instead of accepting the request without counting it.
     */
    private readonly maxKeys = Number.POSITIVE_INFINITY,
  ) {}

  /** Tracked keys; exposed so tests can prove the map stays bounded. */
  get size(): number {
    return this.hits.size;
  }

  /** Records one event; denied results carry the seconds until the oldest slot expires. */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const verdict = this.check(key, now);
    if (!verdict.allowed) return verdict;
    const tracked = this.hits.has(key);
    const recent = this.hits.get(key) ?? [];
    recent.push(now);
    this.hits.set(key, recent);
    // Only a new key can grow the map; pruning on every failure of a tracked peer would
    // turn a full window into repeated O(maxKeys) scans.
    if (!tracked && this.hits.size >= this.pruneThreshold()) this.prune(now - this.windowMs);
    return verdict;
  }

  /** Current verdict without recording an event; used before the expensive check. */
  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const start = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > start);
    if (recent.length === 0) this.hits.delete(key);
    else this.hits.set(key, recent);
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      // Drop expired keys first; if every slot is live, refuse the new key rather than
      // letting the map grow or letting the request through uncounted.
      this.prune(start);
      if (this.hits.size >= this.maxKeys) {
        return { allowed: false, retryAfterSec: this.capacityRetryAfter(now) };
      }
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  private pruneThreshold(): number {
    return Number.isFinite(this.maxKeys) ? this.maxKeys : PRUNE_THRESHOLD;
  }

  /** Seconds until the oldest live entry frees a slot, bounded by one window. */
  private capacityRetryAfter(now: number): number {
    let oldest = now;
    for (const values of this.hits.values()) {
      const at = values[0];
      if (at !== undefined && at < oldest) oldest = at;
    }
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  private prune(start: number): void {
    for (const [key, values] of this.hits) {
      if (values.every((at) => at <= start)) this.hits.delete(key);
    }
  }
}
