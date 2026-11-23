/**
 * HTTP contract types for the Knowledge API (`/api/index/*`, `/api/passages/*`).
 * Mirrors docs/planner/2026-11-06-rag-ingestion-clean-layout.md.
 * Keep this module free of server imports and runtime logic.
 */

/** Search-index lifecycle tracked by the queue. */
export type IndexState = "pending" | "indexing" | "ready" | "error";

/** `none` means the book is not indexed (indexing off) or cannot be indexed. */
export type BookIndexState = "none" | IndexState;

export type IndexErrorCode = "no_text" | "too_large" | "unreadable" | "embedder_failed" | "unknown";

export type IndexError = {
  code: IndexErrorCode;
  message: string;
};

/** Additive `index` field on the book DTO. */
export type BookIndexStatus = {
  state: BookIndexState;
  error: IndexError | null;
};

export type IndexCounts = {
  pending: number;
  indexing: number;
  ready: number;
  error: number;
};

export type EmbeddingsMode = "none" | "local" | "http";

export type EmbeddingsState = "off" | "loading" | "ready" | "unavailable";

export type IndexSearchStatus = {
  /** True when passage vectors are available, enabling hybrid or semantic search. */
  semantic: boolean;
  embeddings: EmbeddingsMode;
  model: string | null;
  state: EmbeddingsState;
};

export type IndexCurrentJob = {
  bookId: string;
  /** Null when the worker cannot report progress. */
  progress: number | null;
};

export type IndexVectorPolicy = "auto" | "demand";

export type IndexVectorsStatus = {
  mode: IndexVectorPolicy;
  /** Number of books eligible for automatic vector indexing. */
  maxBooks: number;
};

/** Effective warm-up policy configured on the server. */
export type IndexWarmupMode = "auto" | "on" | "off";

export type IndexWarmupState = "off" | "idle" | "waiting" | "warming" | "warm" | "paused";

export type IndexWarmupReason =
  | "disabled"
  | "small-index"
  | "low-memory"
  | "over-budget"
  | "memory-pressure"
  | "activity"
  | "cooldown";

export type IndexWarmupScope = "full" | "partial";

export type IndexWarmupStatus = {
  mode: IndexWarmupMode;
  state: IndexWarmupState;
  reason?: IndexWarmupReason;
  scope?: IndexWarmupScope;
  /** Megabytes read into the page cache so far. */
  warmedMB: number;
  /** Megabytes planned for this pass; 0 when the warm-up is off. */
  targetMB: number;
  /** Epoch milliseconds of the last complete pass. */
  finishedAt?: number;
};

export type IndexRetrievalMemory = {
  limitMB: number;
  /** Memory available to the retrieval cache, already calculated. */
  budgetMB: number;
};

export type IndexRetrievalCache = {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  usedKB: number;
  maxKB: number;
  hits: number;
  misses: number;
};

/** Additive `retrieval` field on `GET /api/index/status`; absent on older servers. */
export type IndexRetrievalStatus = {
  memory: IndexRetrievalMemory;
  warmup: IndexWarmupStatus;
  cache: IndexRetrievalCache;
};

/** `GET /api/index/status` */
export type IndexStatusResponse = {
  enabled: boolean;
  search: IndexSearchStatus;
  counts: IndexCounts;
  current: IndexCurrentJob | null;
  /** Changes on every state transition; reload book data only when it differs. */
  revision: number;
  /** Additive backfill controls; absent on older servers. */
  paused?: boolean;
  /** Recent passages per second (60 s EMA); null when idle or unknown. */
  rate?: number | null;
  /** Estimated seconds to finish the current backfill; null when unknown. */
  etaSec?: number | null;
  /** Number of configured ingest workers. */
  workers?: number;
  /** Vector indexing policy; absent on older servers. */
  vectors?: IndexVectorsStatus;
  /** Search warm-up and cache state; absent on older servers. */
  retrieval?: IndexRetrievalStatus;
};

/** `POST /api/index/pause` and `POST /api/index/resume` (200, idempotent). */
export type IndexPauseResponse = {
  paused: boolean;
};

/** `POST /api/index/enqueue` request body. */
export type IndexEnqueueRequest = {
  /** 1–500 book ids; unknown ids are counted as skipped. */
  bookIds: string[];
  /** Also queue vector embeddings; omitted means lexical only. */
  vectors?: boolean;
};

/** `POST /api/index/enqueue` (202). */
export type IndexEnqueueResponse = {
  queued: number;
  skipped: number;
};

/** `POST /api/books/:id/index` (202) */
export type BookReindexResponse = {
  state: IndexState;
};

export type ReindexScope = "failed" | "all";

/** `POST /api/index/reindex` request body. */
export type ReindexRequest = {
  scope: ReindexScope;
};

/** `POST /api/index/reindex` (202) */
export type ReindexResponse = {
  queued: number;
};

export type PassageSearchMode = "hybrid" | "semantic" | "lexical";

export type PassageLocation = {
  /** PDF page; null for EPUB in phase 1. */
  page: number | null;
  /** EPUB chapter/section; null when unknown. */
  section: string | null;
};

export type PassageSearchHit = {
  passageId: number;
  bookId: string;
  bookTitle: string;
  /** Plain text (max 1200 chars); never render as HTML. */
  text: string;
  location: PassageLocation;
  /** Relative relevance; comparable only within the same response. */
  score: number;
};

export type PassageSearchCoverage = {
  indexed: number;
  total: number;
};

/** `GET /api/passages/search` */
export type PassageSearchResponse = {
  mode: PassageSearchMode;
  coverage: PassageSearchCoverage;
  hits: PassageSearchHit[];
};

/** Query parameters for `GET /api/passages/search`. */
export type PassageSearchQuery = {
  /** 2-500 characters. */
  q: string;
  /** Restricts results to one book. */
  bookId?: string;
  /** 1-20; the server defaults to 8. */
  limit?: number;
};
