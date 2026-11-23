export interface QueryCacheOptions {
  /** Maximum stored entries; zero disables admission. */
  maxEntries: number;
  /** Maximum accounted payload bytes; an entry larger than the cap is not stored. */
  maxBytes: number;
  /** Entries older than this are misses and are dropped. Default: ten minutes. */
  ttlMs?: number;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
}

export interface QueryCacheEntry<T> {
  value: T;
  bytes: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Small LRU for retrieval results, bounded by entries and by accounted bytes. Every read
 * reinserts the entry, so the eviction order is least-recently-used. Values are already
 * lightweight (ids and scores); the byte budget is a worst-case guard, not the main limit.
 */
export class QueryCache<T> {
  private readonly entries = new Map<string, QueryCacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private bytes = 0;

  constructor(private readonly options: QueryCacheOptions) {
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  get maxEntries(): number {
    return Math.max(0, this.options.maxEntries);
  }

  get maxBytes(): number {
    return Math.max(0, this.options.maxBytes);
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    // Map preserves insertion order: moving the hit to the tail marks it as recent.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    const accounted = Math.max(1, Math.ceil(bytes));
    if (this.maxEntries === 0 || accounted > this.maxBytes) return;
    this.delete(key);
    this.entries.set(key, { value, bytes: accounted, expiresAt: this.now() + this.ttlMs });
    this.bytes += accounted;
    this.evict();
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.delete(oldest);
    }
  }
}
