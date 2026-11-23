import type { IndexEpoch } from "../../ports/index-epoch.js";
import type {
  LexicalHit,
  LexicalQueryResult,
  PassageQueryStore,
  PassageView,
  ScoredPassage,
  VectorFilter,
} from "../../ports/knowledge.js";
import { QueryCache } from "./QueryCache.js";

/** Only results whose stage cost at least this much are admitted (ADR-3). */
export const DEFAULT_CACHE_ADMISSION_MS = 50;
/** Bumps arrive in bursts while indexing; refuse admission right after one (ADR-4). */
export const DEFAULT_CACHE_QUIET_MS = 5_000;
const DEFAULT_TTL_MS = 10 * 60_000;
/** Two 8-byte numbers per hit plus a small per-entry overhead for the Map node. */
const BYTES_PER_HIT = 16;
const ENTRY_OVERHEAD_BYTES = 64;

export interface CachedPassageQueryStoreOptions {
  epoch: IndexEpoch;
  /** Entry ceiling from the memory tiers. */
  maxEntries: number;
  /** Byte ceiling from the memory tiers. */
  maxBytes: number;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
  /** Test seam; defaults to ten minutes. */
  ttlMs?: number;
  /** Test seam; defaults to 50 ms. */
  admissionMs?: number;
  /** Test seam; defaults to five seconds. */
  quietMs?: number;
}

export interface CacheStats {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  usedBytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
}

type CachedValue = LexicalQueryResult | readonly ScoredPassage[] | number;

export interface ClosablePassageQueryStore extends PassageQueryStore {
  close(): Promise<void>;
}

/**
 * Decorates the retrieval store with a process-local LRU. Only ids and scores are kept,
 * never hydrated passages: a renamed book or a deleted passage must not come back stale,
 * and `hydrate` (which already drops missing ids) always reads the current rows.
 *
 * A stage is stored only when it succeeded, was complete (the full FTS plan ran inside
 * its deadline), took at least `admissionMs`, the epoch did not change during the read,
 * and no write happened in the last `quietMs`. Concurrent misses for the same key share
 * one worker round-trip. The query text is part of the in-memory key, folded only in
 * whitespace; it is never logged, returned by a route or written to disk.
 */
export class CachedPassageQueryStore implements PassageQueryStore {
  private readonly cache: QueryCache<CachedValue>;
  private readonly pending = new Map<string, Promise<CachedValue>>();
  private readonly now: () => number;
  private readonly admissionMs: number;
  private readonly quietMs: number;
  private lastEpoch: number;
  /** When an epoch change was observed; `-Infinity` until the first one. */
  private epochChangedAt = Number.NEGATIVE_INFINITY;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: ClosablePassageQueryStore,
    private readonly options: CachedPassageQueryStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.admissionMs = Math.max(0, options.admissionMs ?? DEFAULT_CACHE_ADMISSION_MS);
    this.quietMs = Math.max(0, options.quietMs ?? DEFAULT_CACHE_QUIET_MS);
    this.lastEpoch = options.epoch.current();
    this.cache = new QueryCache<CachedValue>({
      maxEntries: options.maxEntries,
      maxBytes: options.maxBytes,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      now: this.now,
    });
  }

  async searchLexical(q: string, limit: number, bookId?: string): Promise<LexicalHit[]> {
    return (await this.searchLexicalResult(q, limit, bookId)).hits;
  }

  searchLexicalResult(q: string, limit: number, bookId?: string): Promise<LexicalQueryResult> {
    const epoch = this.observeEpoch();
    const key = `L|${epoch}|${bookId ?? "*"}|${limit}|${normalizeQuery(q)}`;
    return this.cached(
      key,
      () => this.inner.searchLexicalResult(q, limit, bookId),
      (value) => 64 + value.hits.length * BYTES_PER_HIT,
      true,
      (value) => value.complete,
    );
  }

  hydrate(ids: number[]): Promise<PassageView[]> {
    // Hydration is sub-millisecond and must stay fresh; it is deliberately not cached.
    return this.inner.hydrate(ids);
  }

  nearest(query: Float32Array, limit: number, filter?: VectorFilter): Promise<ScoredPassage[]> {
    const epoch = this.observeEpoch();
    // The vector digest identifies the embedded query exactly, so the raw question never
    // has to be retained here; the model change that would alter the vector bumps the epoch.
    const key = `V|${epoch}|${limit}|${filterKey(filter)}|${vectorKey(query)}`;
    return this.cached(key, () => this.inner.nearest(query, limit, filter), (value) => 64 + value.length * BYTES_PER_HIT, true);
  }

  vectorCount(): Promise<number> {
    const epoch = this.observeEpoch();
    // Invariant for an entire epoch: one COUNT(*) per epoch instead of one per query.
    return this.cached(`C|${epoch}`, () => this.inner.vectorCount(), () => 8, false);
  }

  /** Counters only: no key, query text or passage ever leaves this object. */
  stats(): CacheStats {
    return {
      enabled: true,
      entries: this.cache.size,
      maxEntries: this.cache.maxEntries,
      usedBytes: this.cache.usedBytes,
      maxBytes: this.cache.maxBytes,
      hits: this.hits,
      misses: this.misses,
    };
  }

  async close(): Promise<void> {
    this.cache.clear();
    this.pending.clear();
    await this.inner.close();
  }

  private async cached<T extends CachedValue>(
    key: string,
    load: () => Promise<T>,
    bytesOf: (value: T) => number,
    admissionByCost: boolean,
    accept?: (value: T) => boolean,
  ): Promise<T> {
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.hits += 1;
      return hit as T;
    }
    this.misses += 1;
    const running = this.pending.get(key);
    if (running) return running as Promise<T>;

    const epoch = this.lastEpoch;
    const started = this.now();
    const promise = (async () => {
      const value = await load();
      const elapsed = this.now() - started;
      // A rejected stage never reaches here. A successful one is stored only when it is
      // complete, the index did not change meanwhile and it is not part of an active burst.
      if ((accept?.(value) ?? true) && this.canStore(epoch, elapsed, admissionByCost)) {
        this.cache.set(key, value, bytesOf(value));
      }
      return value;
    })();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  private canStore(epoch: number, elapsedMs: number, admissionByCost: boolean): boolean {
    if (this.options.epoch.current() !== epoch) return false;
    if (admissionByCost && elapsedMs < this.admissionMs) return false;
    if (this.now() - this.epochChangedAt < this.quietMs) return false;
    return true;
  }

  /** Clears on any observed change and starts the quiet window used by admission. */
  private observeEpoch(): number {
    const epoch = this.options.epoch.current();
    if (epoch !== this.lastEpoch) {
      this.lastEpoch = epoch;
      this.epochChangedAt = this.now();
      this.cache.clear();
    }
    return epoch;
  }
}

/**
 * Composition helper: `off` returns the inner store untouched, so every read takes the
 * exact same path as before the cache existed.
 */
export function withSearchCache(
  inner: ClosablePassageQueryStore,
  options: CachedPassageQueryStoreOptions | null,
): ClosablePassageQueryStore {
  return options === null ? inner : new CachedPassageQueryStore(inner, options);
}

/**
 * Only whitespace is folded: it is a separator to the tokenizer, so collapsing runs cannot
 * change the plan. Case and code points are kept because both decide the plan before the
 * cache sees it: `C` is a significant single-character term while `c` is dropped, and an
 * NFD string tokenizes differently from its NFC form (`a\u0308b` is two one-letter tokens,
 * `äb` is one). Folding either would serve one query's result for the other.
 */
function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/gu, " ");
}

/** A cheap 64-bit-ish digest of the query embedding; collisions only cost a cache miss. */
function vectorKey(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    first = Math.imul(first ^ byte, 0x01000193);
    second = Math.imul(second ^ byte, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}-${vector.length}`;
}

/** Book-id order matters for tie iteration, so it is preserved rather than sorted. */
function filterKey(filter?: VectorFilter): string {
  if (!filter) return "*";
  return JSON.stringify({
    bookId: filter.bookId ?? null,
    bookIds: filter.bookIds ?? null,
    includeSample: filter.includeSample ?? false,
    maxVectors: filter.maxVectors ?? null,
  });
}
