/**
 * Recommendation use case (ADR-15/ADR-19): one retrieval feeds a per-book aggregation,
 * metadata matches add books the index does not cover, and a deterministic cut produces
 * at most five candidates. Only the Library context is read; nothing is written.
 */
import {
  rankBookCandidates,
  type RankingBook,
  type RankingHit,
  type RankedBook,
} from "../domain/assistant/bookRanking.js";
import { recommendationTerms } from "../domain/assistant/recommendIntent.js";
import { readingStatusOf, type ReadingStatus } from "../domain/reading/ReadingStatus.js";
import type { BookCandidateDetails, BookCandidateSource } from "../ports/assistant.js";
import type { PassageSearchHit } from "../ports/knowledge.js";
import type { Logger, ProgressRepository, StoredProgress } from "../ports/index.js";

/** Metadata candidates read per turn; the ranking keeps at most five. */
export const METADATA_MATCH_LIMIT = 50;

export type RecommendationSearch = "used" | "not_used" | "timed_out";

export interface BookRecommendationInput {
  question: string;
  /** Hits from the single wide retrieval, already scored by `PassageSearch`. */
  hits: readonly PassageSearchHit[];
  search: RecommendationSearch;
}

export interface RecommendedEvidence {
  passageId: number;
  page: number | null;
  section: string | null;
  text: string;
}

export interface RecommendedBook {
  /** Shortlist position, 1..5; the same number the model uses in `[book:n]`. */
  n: number;
  bookId: string;
  title: string;
  author: string;
  format: "pdf" | "epub";
  language: string | null;
  series: string | null;
  tags: string[];
  hasCover: boolean;
  coverRev: number | null;
  progress: { status: ReadingStatus; percentage: number };
  matched: string[];
  evidence: RecommendedEvidence[];
  source: "passages" | "metadata" | "both";
}

export type RecommendationStatus = "ready" | "none" | "unavailable";

export interface RecommendationOutcome {
  status: RecommendationStatus;
  books: RecommendedBook[];
}

/** Narrow seam so `Chat` can be tested with a deterministic double. */
export interface BookRecommendationService {
  recommend(input: BookRecommendationInput): RecommendationOutcome;
}

export class BookRecommendations implements BookRecommendationService {
  constructor(
    private readonly candidates: BookCandidateSource,
    private readonly progress: ProgressRepository,
    private readonly log: Logger = { info: () => {}, error: () => {} },
  ) {}

  recommend(input: BookRecommendationInput): RecommendationOutcome {
    const terms = recommendationTerms(input.question);
    const hitIds = new Set(input.hits.map((hit) => hit.bookId));
    let degraded = false;
    let metadataIds = new Set<string>();
    if (terms.length > 0) {
      try {
        metadataIds = new Set(this.candidates.metadataMatches(terms, METADATA_MATCH_LIMIT));
      } catch {
        // Never the terms: they are the user's question.
        degraded = true;
        this.log.warn?.("book recommendation metadata lookup failed");
      }
    }
    const ids = [...new Set([...hitIds, ...metadataIds])];
    let details: BookCandidateDetails[] = [];
    if (ids.length > 0) {
      try {
        details = this.candidates.details(ids);
      } catch {
        degraded = true;
        this.log.warn?.("book recommendation details lookup failed");
      }
    }
    if (details.length === 0) return this.empty(input.search, degraded);
    // `details` is the source of truth: a hit on a deleted, pending or failed book has no
    // candidate row, so its passages are dropped instead of being sent to the model.
    const detailIds = new Set(details.map((detail) => detail.bookId));
    const stored = this.readProgress([...detailIds]);
    const books: RankingBook[] = details.map((detail) => {
      const percentage = clampPercentage(stored.get(detail.bookId)?.percentage ?? 0);
      return {
        bookId: detail.bookId,
        title: detail.title,
        author: detail.author,
        format: detail.format,
        language: detail.language,
        series: detail.series,
        description: detail.description,
        tags: detail.tags,
        hasCover: detail.hasCover,
        coverRev: detail.coverRev,
        percentage,
        fromPassages: hitIds.has(detail.bookId),
        fromMetadata: metadataIds.has(detail.bookId),
      };
    });
    const hits: RankingHit[] = input.hits
      .filter((hit) => detailIds.has(hit.bookId))
      .map((hit) => ({
        passageId: hit.passageId,
        bookId: hit.bookId,
        score: hit.score,
        text: hit.text,
        page: hit.location.page,
        section: hit.location.section,
      }));
    const ranked = rankBookCandidates({ hits, books, terms });
    if (ranked.length === 0) return this.empty(input.search, degraded);
    return {
      status: "ready",
      books: ranked.map((book, index) => toRecommendedBook(book, index + 1)),
    };
  }

  private readProgress(ids: readonly string[]): Map<string, StoredProgress> {
    if (ids.length === 0) return new Map();
    try {
      return this.progress.getMany([...ids]);
    } catch {
      this.log.warn?.("book recommendation progress lookup failed");
      return new Map();
    }
  }

  /**
   * No shortlist is `unavailable` when the search was degraded or a metadata read
   * failed: the turn cannot honestly claim the library has no matching book.
   */
  private empty(search: RecommendationSearch, degraded: boolean): RecommendationOutcome {
    return { status: search === "timed_out" || degraded ? "unavailable" : "none", books: [] };
  }
}

function toRecommendedBook(book: RankedBook, n: number): RecommendedBook {
  return {
    n,
    bookId: book.bookId,
    title: book.title,
    author: book.author,
    format: book.format,
    language: book.language,
    series: book.series,
    tags: [...book.tags],
    hasCover: book.hasCover,
    coverRev: book.coverRev,
    progress: { status: readingStatusOf(book.percentage), percentage: book.percentage },
    matched: book.matched,
    evidence: book.evidence.map((hit) => ({
      passageId: hit.passageId,
      page: hit.page,
      section: hit.section,
      text: hit.text,
    })),
    source: book.fromPassages && book.fromMetadata ? "both" : book.fromPassages ? "passages" : "metadata",
  };
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
