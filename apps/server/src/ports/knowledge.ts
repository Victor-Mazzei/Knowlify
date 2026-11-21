import type { BookIndex, Passage } from "../domain/knowledge/BookIndex.js";

export interface IngestJob {
  bookId: string;
  path: string;
  format: "pdf" | "epub";
  knownHash: string | null;
  indexVersion: string;
  /**
   * Whether the ingestion may store vectors. When false the worker follows the
   * lexical path even if an embedder is configured (automatic vector policy).
   * Absent means true for backwards compatibility with direct runner tests.
   */
  vectors?: boolean;
}

export interface IngestBatch {
  passages: Passage[];
  vectors: Float32Array[] | null;
}

export type IngestOutcome =
  | { kind: "unchanged"; contentHash: string; indexVersion: string }
  | { kind: "done"; contentHash: string; chunkCount: number; indexVersion: string };

export interface IngestSink {
  /** `null` while the hash is postponed (first indexing no longer hashes before extracting). */
  onStart(contentHash: string | null): void;
  onBatch(batch: IngestBatch): Promise<void>;
  onProgress(fraction: number): void;
}

export interface EmbeddingsStatus {
  mode: "none" | "local" | "http";
  model: string | null;
  state: "off" | "loading" | "ready" | "unavailable";
}

export interface IngestionRunner {
  run(job: IngestJob, sink: IngestSink): Promise<IngestOutcome>;
  embedQuery(text: string): Promise<Float32Array | null>;
  embeddings(): EmbeddingsStatus;
  indexVersion(): string;
  onEmbeddingsReady(cb: () => void): void;
  close(): Promise<void>;
}

export interface BookIndexRepository {
  get(bookId: string): BookIndex | undefined;
  upsertPending(i: {
    bookId: string;
    priority: 0 | 1;
    fingerprint: string | null;
    now: number;
    resetAttempts: boolean;
  }): void;
  /** Same upsert in one transaction, for boot reconciliation in blocks (ADR-C2). */
  upsertPendingMany(items: readonly PendingIndexUpsert[]): void;
  claimNext(now: number): BookIndex | undefined;
  nextDueAt(): number | null;
  save(index: BookIndex): void;
  resetInterrupted(): number;
  statesFor(bookIds: string[]): Map<string, BookIndex>;
  counts(): { pending: number; indexing: number; ready: number; error: number };
  requeue(scope: "failed" | "all", now: number): number;
  staleIds(currentVersion: string): string[];
  unindexedReadyBookIds(): string[];
  /** Mean stored chunk count, used for the status ETA. */
  averageChunkCount(): number | null;
  /** Ready books whose stored version includes vectors (feeds the automatic-vector cap). */
  vectorBookCount(): number;
  /** PASSIVE WAL checkpoint after a batch of indexed books (ADR-C2). */
  walCheckpoint(): void;
  revision(): number;
}

export interface PendingIndexUpsert {
  bookId: string;
  priority: 0 | 1;
  fingerprint: string | null;
  now: number;
  resetAttempts: boolean;
}

export interface KeyValueStore {
  get(key: string): string | undefined;
  set(values: Readonly<Record<string, string>>): void;
  delete(keys: readonly string[]): void;
}

export interface PassageRepository {
  clear(bookId: string): void;
  append(bookId: string, items: { passage: Passage; vector: Float32Array | null }[]): void;
  searchLexical(q: string, limit: number, bookId?: string): { passageId: number; rank: number }[];
  hydrate(ids: number[]): PassageView[];
}

export interface VectorFilter {
  bookId?: string;
  /** Restrict the scan to the given books (lexical pre-filter above the scan ceiling). */
  bookIds?: string[];
}

export interface VectorStore {
  nearest(
    query: Float32Array,
    limit: number,
    filter?: VectorFilter,
  ): Promise<{ passageId: number; score: number }[]>;
  /** Number of stored vectors, used to decide whether the exact scan needs a pre-filter. */
  count(): number;
}

export interface PassageView {
  passageId: number;
  bookId: string;
  bookTitle: string;
  text: string;
  page: number | null;
  section: string | null;
}

/** Read model returned by passage retrieval; shared by search and the assistant port. */
export interface PassageSearchHit {
  passageId: number;
  bookId: string;
  bookTitle: string;
  text: string;
  location: { page: number | null; section: string | null };
  score: number;
}

export interface IndexScheduler {
  schedule(book: { id: string; size: number; mtime: number | null }, priority: 0 | 1): void;
}
