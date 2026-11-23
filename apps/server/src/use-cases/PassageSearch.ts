import { ValidationError } from "../domain/errors.js";
import type { BookRepository, Logger } from "../ports/index.js";
import type {
  BookIndexRepository,
  IngestionRunner,
  LexicalHit,
  PassageQueryStore,
  PassageSearchHit,
  PassageView,
  ScoredPassage,
  VectorFilter,
} from "../ports/knowledge.js";

export type { PassageSearchHit } from "../ports/knowledge.js";

export class PassageSearchDisabledError extends Error {}

export type PassageSearchMode = "hybrid" | "semantic" | "lexical";

export interface PassageSearchQuery {
  q: string;
  bookId?: string;
  limit: number;
}

/** Internal call options; the HTTP and MCP routes keep the default minimum of two characters. */
export interface PassageSearchCallOptions {
  /** The tutor may ask a single-character question such as `R`, `C` or `7`. */
  allowShortQuery?: boolean;
}

export interface PassageSearchResult {
  mode: PassageSearchMode;
  coverage: { indexed: number; total: number };
  hits: PassageSearchHit[];
  /**
   * A search read timed out or the worker was discarded. The prompt uses this to say
   * "Library search: timed out." instead of claiming that no passage matched.
   */
  unavailable: boolean;
}

export interface PassageSearchOptions {
  enabled: boolean;
  /** Above this many stored vectors an unscoped scan is restricted to books matched lexically. */
  vectorScanMax?: number;
  /** Book ids kept from the lexical pre-filter when the exact scan is over the ceiling. */
  prefilterBooks?: number;
  /**
   * A local model load, a download or a worker busy with ingestion can take minutes.
   * Past this ceiling the query degrades to lexical search instead of holding the turn.
   */
  embedTimeoutMs?: number;
  /**
   * Optional observer around each retrieval. The warm-up controller uses it to pause
   * background reads before a query reaches the worker and to start only after the first
   * query has completed. It must be cheap and synchronous.
   */
  activity?: { begin(): void; end(): void };
}

/** Reciprocal rank fusion constant from the IR literature; scores are relative. */
const RRF_K = 60;
const MAX_TEXT_CHARS = 1_200;
/**
 * Internal ceiling. The HTTP and MCP routes validate a smaller limit; the tutor's
 * recommendation turn asks for `RECOMMEND_PASSAGES = 40` in one retrieval.
 */
const MAX_LIMIT = 40;
const MAX_QUERY_CHARS = 500;
const CANDIDATES_PER_SOURCE = 4;
const DEFAULT_VECTOR_SCAN_MAX = 300_000;
const PREFILTER_PASSAGES = 200;
const DEFAULT_PREFILTER_BOOKS = 50;
export const DEFAULT_EMBED_TIMEOUT_MS = 2_000;

/** One flag per search call, so concurrent turns never share availability state. */
interface SearchState {
  unavailable: boolean;
}

/**
 * Hybrid retrieval: FTS5 for lexical matches and exact cosine over stored vectors.
 * RRF merges both rankings without having to calibrate bm25 against cosine. If the
 * embedder is off or failing, lexical search still answers.
 *
 * All index reads go through `PassageQueryStore`, which production implements with a
 * worker thread: FTS5 cost grows with the corpus and the vector scan touches every
 * stored vector, so neither may run on the API event loop. Any store failure or timeout
 * degrades to fewer sources instead of failing the turn.
 */
export class PassageSearch {
  constructor(
    private store: PassageQueryStore,
    private runner: IngestionRunner,
    private books: BookRepository,
    private indexes: BookIndexRepository,
    private options: PassageSearchOptions,
    private log: Logger = { info: () => {}, error: () => {} },
  ) {}

  async search(query: PassageSearchQuery, options: PassageSearchCallOptions = {}): Promise<PassageSearchResult> {
    if (!this.options.enabled) throw new PassageSearchDisabledError("Indexing is disabled");
    const q = query.q.trim();
    const minimumChars = options.allowShortQuery ? 1 : 2;
    if (q.length < minimumChars || q.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`Search query must be between ${minimumChars} and ${MAX_QUERY_CHARS} characters`);
    }
    this.options.activity?.begin();
    try {
      return await this.run({ ...query, q });
    } finally {
      this.options.activity?.end();
    }
  }

  private async run(query: PassageSearchQuery): Promise<PassageSearchResult> {
    const q = query.q;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(query.limit) || 8));
    const candidates = limit * CANDIDATES_PER_SOURCE;
    const state: SearchState = { unavailable: false };

    const lexical = await this.lexical(q, candidates, query.bookId, state);
    const semantic = await this.semanticCandidates(q, candidates, query.bookId, state);
    const mode: PassageSearchMode = semantic.embedded && semantic.hits.length > 0
      ? lexical.length ? "hybrid" : "semantic"
      : "lexical";

    const scores = new Map<number, number>();
    addRanked(scores, lexical.map((hit) => hit.passageId));
    addRanked(scores, semantic.hits.map((hit) => hit.passageId));
    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const top = ordered[0]?.[1] ?? 0;
    const views = new Map((await this.hydrate(ordered.map(([id]) => id), state)).map((view) => [view.passageId, view]));

    return {
      mode,
      coverage: this.coverage(query.bookId),
      hits: ordered.flatMap(([passageId, score]) => {
        const view = views.get(passageId);
        if (!view) return [];
        return [toHit(view, top > 0 ? score / top : 0)];
      }),
      unavailable: state.unavailable,
    };
  }

  private async lexical(q: string, limit: number, bookId: string | undefined, state: SearchState): Promise<LexicalHit[]> {
    const started = Date.now();
    try {
      return await this.store.searchLexical(q, limit, bookId);
    } catch {
      // Timed-out or crashed worker: the turn continues with the sources it has, and
      // the prompt is told the search was unavailable instead of a clean no-match.
      state.unavailable = true;
      this.failed("lexical search", started, "answering with fewer sources");
      return [];
    }
  }

  private async hydrate(ids: number[], state: SearchState): Promise<PassageView[]> {
    if (ids.length === 0) return [];
    const started = Date.now();
    try {
      return await this.store.hydrate(ids);
    } catch {
      state.unavailable = true;
      this.failed("passage hydration", started, "answering with fewer sources");
      return [];
    }
  }

  private async semanticCandidates(
    q: string,
    limit: number,
    bookId: string | undefined,
    state: SearchState,
  ): Promise<{ embedded: boolean; hits: ScoredPassage[] }> {
    const embeddings = this.runner.embeddings();
    if (embeddings.mode === "none" || embeddings.state !== "ready") return { embedded: false, hits: [] };
    let vector: Float32Array | null;
    try {
      vector = await this.embedQuery(q);
    } catch (error) {
      // The embedder is an optional capability; a failed query must not break search.
      this.log.error(error, "query embedding failed; falling back to lexical search");
      return { embedded: false, hits: [] };
    }
    if (!vector) return { embedded: false, hits: [] };
    let filter: VectorFilter;
    const started = Date.now();
    try {
      filter = await this.vectorFilter(q, bookId, state);
    } catch {
      state.unavailable = true;
      this.failed("vector pre-filter", started, "falling back to lexical search");
      return { embedded: false, hits: [] };
    }
    const scanned = Date.now();
    try {
      return { embedded: true, hits: await this.store.nearest(vector, limit, filter) };
    } catch {
      state.unavailable = true;
      this.failed("vector search", scanned, "falling back to lexical search");
      return { embedded: false, hits: [] };
    }
  }

  /**
   * Index reads degrade to fewer sources; one short warning with the stage and duration
   * is enough to diagnose it. The error object (and its stack) adds nothing here, and the
   * query, passages and SQL must never reach a log.
   */
  private failed(stage: string, started: number, outcome: string): void {
    this.log.warn?.(`${stage} failed after ${Date.now() - started} ms; ${outcome}`);
  }

  /** Aborts the request on timeout so the runner drops it instead of completing it later. */
  private embedQuery(q: string): Promise<Float32Array | null> {
    const controller = new AbortController();
    return withTimeout(
      this.runner.embedQuery(q, { signal: controller.signal }),
      this.options.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS,
      "The query embedding took too long",
      () => controller.abort(),
    );
  }

  /**
   * Exact scans are viable up to a few hundred thousand vectors. Above the ceiling the
   * scan is restricted to books FTS already considers relevant; if nothing matches
   * lexically the query still gets a bounded, evenly spread sample instead of silently
   * losing semantic recall.
   */
  private async vectorFilter(q: string, bookId: string | undefined, state: SearchState): Promise<VectorFilter> {
    if (bookId) return { bookId };
    const ceiling = this.options.vectorScanMax ?? DEFAULT_VECTOR_SCAN_MAX;
    if (await this.store.vectorCount() <= ceiling) return {};
    const limit = this.options.prefilterBooks ?? DEFAULT_PREFILTER_BOOKS;
    const hits = await this.lexical(q, PREFILTER_PASSAGES, undefined, state);
    const views = hits.length > 0 ? await this.hydrate(hits.map((hit) => hit.passageId), state) : [];
    const bookIds = [...new Set(views.map((view) => view.bookId))].slice(0, limit);
    if (bookIds.length > 0) {
      // Keep the lexical neighbourhood and add a rotating uniform stride sample of every
      // eligible book; the same maxVectors budget bounds the combined scan.
      return { bookIds, includeSample: true, maxVectors: ceiling };
    }
    return { maxVectors: ceiling };
  }

  private coverage(bookId?: string): { indexed: number; total: number } {
    if (bookId) {
      const book = this.books.get(bookId);
      if (!book) return { indexed: 0, total: 0 };
      return { indexed: this.indexes.get(bookId)?.state === "ready" ? 1 : 0, total: 1 };
    }
    return { indexed: this.indexes.counts().ready, total: this.books.count() };
  }
}

function addRanked(scores: Map<number, number>, ids: number[]): void {
  ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank)));
}

function toHit(view: PassageView, score: number): PassageSearchHit {
  return {
    passageId: view.passageId,
    bookId: view.bookId,
    bookTitle: view.bookTitle,
    text: view.text.length > MAX_TEXT_CHARS ? view.text.slice(0, MAX_TEXT_CHARS) : view.text,
    location: { page: view.page, section: view.section },
    score,
  };
}

/**
 * Resolves with the work or rejects when the ceiling passes. The timeout callback aborts
 * the underlying request, and the original promise keeps its handlers attached, so a late
 * result or failure never becomes unhandled.
 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
