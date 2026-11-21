import type { MetadataCandidate, MetadataLookupQuery } from "../../ports/library-metadata.js";

interface Entry {
  value: MetadataCandidate[];
  expiresAt: number;
}

/**
 * In-memory LRU for external metadata (ADR-4). The data is ephemeral by definition, so
 * it stays out of SQLite; the cache is per-process, which matches the single-user server.
 */
export class MetadataCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxEntries = 200,
    private readonly now: () => number = Date.now,
  ) {}

  static key(provider: string, query: MetadataLookupQuery): string {
    return "isbn" in query
      ? `${provider}|isbn:${query.isbn}`
      : `${provider}|title:${query.title.toLowerCase()}|author:${query.author?.toLowerCase() ?? ""}`;
  }

  get(provider: string, query: MetadataLookupQuery): MetadataCandidate[] | undefined {
    const key = MetadataCache.key(provider, query);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency: delete + set moves the key to the end of the insertion order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(provider: string, query: MetadataLookupQuery, value: MetadataCandidate[]): void {
    const key = MetadataCache.key(provider, query);
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
