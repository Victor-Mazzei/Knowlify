import type { BookIndexStatus, IndexRetrievalStatus, IndexStatusResponse, IndexWarmupStatus } from "./types";

export function indexStatus(overrides: Partial<IndexStatusResponse> = {}): IndexStatusResponse {
  return {
    enabled: true,
    search: { semantic: true, embeddings: "local", model: "Xenova/multilingual-e5-small", state: "ready" },
    counts: { pending: 0, indexing: 0, ready: 0, error: 0 },
    current: null,
    revision: 1,
    ...overrides,
  };
}

/** Nothing queued, embeddings ready. */
export const idleIndexStatus = indexStatus();

/** Importing metadata is idle; two of nine books are searchable. */
export const busyIndexStatus = indexStatus({
  counts: { pending: 6, indexing: 1, ready: 2, error: 0 },
  current: { bookId: "b1", progress: 0.42 },
  revision: 7,
});

/** Lexical fallback: the local model could not load. */
export const unavailableEmbedderStatus = indexStatus({
  search: { semantic: false, embeddings: "local", model: null, state: "unavailable" },
  counts: { pending: 0, indexing: 0, ready: 12, error: 2 },
  revision: 11,
});

/** Backfill running with the new runtime fields (rate, ETA, workers, vectors). */
export const runningIndexStatus = indexStatus({
  counts: { pending: 8, indexing: 1, ready: 2, error: 0 },
  current: { bookId: "b1", progress: 0.42 },
  paused: false,
  rate: 24,
  etaSec: 10_800,
  workers: 3,
  vectors: { mode: "auto", maxBooks: 1000 },
  revision: 12,
});

/** User paused the queue; work remains queued. */
export const pausedIndexStatus = indexStatus({
  counts: { pending: 6, indexing: 0, ready: 2, error: 0 },
  paused: true,
  rate: null,
  etaSec: null,
  workers: 3,
  vectors: { mode: "auto", maxBooks: 1000 },
  revision: 13,
});

/** Warm-up and cache block for `GET /api/index/status`; absent on older servers. */
export function retrievalStatus(
  overrides: {
    warmup?: Partial<IndexWarmupStatus>;
    cache?: Partial<IndexRetrievalStatus["cache"]>;
  } = {},
): IndexRetrievalStatus {
  return {
    memory: { limitMB: 4096, budgetMB: 1536 },
    warmup: {
      mode: "auto",
      state: "warm",
      scope: "full",
      warmedMB: 120,
      targetMB: 120,
      finishedAt: 1_764_000_000_000,
      ...overrides.warmup,
    },
    cache: {
      enabled: true,
      entries: 42,
      maxEntries: 512,
      usedKB: 1536,
      maxKB: 8192,
      hits: 120,
      misses: 8,
      ...overrides.cache,
    },
  };
}

/** The poller keeps refreshing while the warm-up waits or reads the index. */
export const waitingIndexStatus = indexStatus({
  retrieval: retrievalStatus({ warmup: { state: "waiting", warmedMB: 0 } }),
});
export const warmingIndexStatus = indexStatus({
  retrieval: retrievalStatus({ warmup: { state: "warming", warmedMB: 75.6 } }),
});
export const warmIndexStatus = indexStatus({ retrieval: retrievalStatus() });

export function bookIndex(state: BookIndexStatus["state"], message = "The file could not be read."): BookIndexStatus {
  return { state, error: state === "error" ? { code: "unreadable", message } : null };
}
