/**
 * Small in-memory sliding window. The MCP endpoint is a single-process local server
 * (Docker or the desktop app), so a shared store would add a dependency without value.
 */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Records one event; denied results carry the seconds until the oldest slot expires. */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const start = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > start);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.prune(start);
    return { allowed: true, retryAfterSec: 0 };
  }

  private prune(start: number): void {
    if (this.hits.size < 1_000) return;
    for (const [key, values] of this.hits) {
      if (values.every((at) => at <= start)) this.hits.delete(key);
    }
  }
}
