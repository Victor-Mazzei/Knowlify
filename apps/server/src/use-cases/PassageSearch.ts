import { ValidationError } from "../domain/errors.js";
import type { BookRepository, Logger } from "../ports/index.js";
import type {
  BookIndexRepository,
  IngestionRunner,
  PassageRepository,
  PassageSearchHit,
  PassageView,
  VectorStore,
} from "../ports/knowledge.js";

export type { PassageSearchHit } from "../ports/knowledge.js";

export class PassageSearchDisabledError extends Error {}

export type PassageSearchMode = "hybrid" | "semantic" | "lexical";

export interface PassageSearchQuery {
  q: string;
  bookId?: string;
  limit: number;
}

export interface PassageSearchResult {
  mode: PassageSearchMode;
  coverage: { indexed: number; total: number };
  hits: PassageSearchHit[];
}

export interface PassageSearchOptions {
  enabled: boolean;
  /** Above this many stored vectors an unscoped scan is restricted to books matched lexically. */
  vectorScanMax?: number;
  /** Book ids kept from the lexical pre-filter when the exact scan is over the ceiling. */
  prefilterBooks?: number;
}

/** Reciprocal rank fusion constant from the IR literature; scores are relative. */
const RRF_K = 60;
const MAX_TEXT_CHARS = 1_200;
const MAX_LIMIT = 20;
const MAX_QUERY_CHARS = 500;
const CANDIDATES_PER_SOURCE = 4;
const DEFAULT_VECTOR_SCAN_MAX = 300_000;
const PREFILTER_PASSAGES = 200;
const DEFAULT_PREFILTER_BOOKS = 50;

/**
 * Hybrid retrieval: FTS5 for lexical matches and exact cosine over stored vectors.
 * RRF merges both rankings without having to calibrate bm25 against cosine. If the
 * embedder is off or failing, lexical search still answers.
 */
export class PassageSearch {
  constructor(
    private passages: PassageRepository,
    private vectors: VectorStore,
    private runner: IngestionRunner,
    private books: BookRepository,
    private indexes: BookIndexRepository,
    private options: PassageSearchOptions,
    private log: Logger = { info: () => {}, error: () => {} },
  ) {}

  async search(query: PassageSearchQuery): Promise<PassageSearchResult> {
    if (!this.options.enabled) throw new PassageSearchDisabledError("Indexing is disabled");
    const q = query.q.trim();
    if (q.length < 2 || q.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`Search query must be between 2 and ${MAX_QUERY_CHARS} characters`);
    }
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(query.limit) || 8));
    const candidates = limit * CANDIDATES_PER_SOURCE;

    const lexical = this.passages.searchLexical(q, candidates, query.bookId);
    const semantic = await this.semanticCandidates(q, candidates, query.bookId);
    const mode: PassageSearchMode = semantic.embedded && semantic.hits.length > 0
      ? lexical.length ? "hybrid" : "semantic"
      : "lexical";

    const scores = new Map<number, number>();
    addRanked(scores, lexical.map((hit) => hit.passageId));
    addRanked(scores, semantic.hits.map((hit) => hit.passageId));
    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const top = ordered[0]?.[1] ?? 0;
    const views = new Map(this.passages.hydrate(ordered.map(([id]) => id)).map((view) => [view.passageId, view]));

    return {
      mode,
      coverage: this.coverage(query.bookId),
      hits: ordered.flatMap(([passageId, score]) => {
        const view = views.get(passageId);
        if (!view) return [];
        return [toHit(view, top > 0 ? score / top : 0)];
      }),
    };
  }

  private async semanticCandidates(
    q: string,
    limit: number,
    bookId?: string,
  ): Promise<{ embedded: boolean; hits: { passageId: number; score: number }[] }> {
    const embeddings = this.runner.embeddings();
    if (embeddings.mode === "none" || embeddings.state !== "ready") return { embedded: false, hits: [] };
    try {
      const vector = await this.runner.embedQuery(q);
      if (!vector) return { embedded: false, hits: [] };
      const bookIds = bookId ? null : this.prefilterBookIds(q);
      if (bookIds && bookIds.length === 0) return { embedded: true, hits: [] };
      const filter = bookId ? { bookId } : bookIds ? { bookIds } : {};
      return { embedded: true, hits: await this.vectors.nearest(vector, limit, filter) };
    } catch (error) {
      // The embedder is an optional capability; a failed query must not break search.
      this.log.error(error, "query embedding failed; falling back to lexical search");
      return { embedded: false, hits: [] };
    }
  }

  /**
   * Exact scans are viable up to a few hundred thousand vectors. Above the ceiling the
   * scan is restricted to books FTS already considers relevant; if nothing matches
   * lexically the query degrades to pure lexical search.
   */
  private prefilterBookIds(q: string): string[] | null {
    const ceiling = this.options.vectorScanMax ?? DEFAULT_VECTOR_SCAN_MAX;
    if (this.vectors.count() <= ceiling) return null;
    const limit = this.options.prefilterBooks ?? DEFAULT_PREFILTER_BOOKS;
    const hits = this.passages.searchLexical(q, PREFILTER_PASSAGES);
    if (hits.length === 0) return [];
    const views = this.passages.hydrate(hits.map((hit) => hit.passageId));
    return [...new Set(views.map((view) => view.bookId))].slice(0, limit);
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
