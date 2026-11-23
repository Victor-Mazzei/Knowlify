/**
 * Deterministic ranking of the user's own books (ADR-15). Pure: the same hits, metadata
 * and terms always produce the same shortlist, so the model only chooses among a list
 * the server already trusts. Weights and cuts are constants calibrated by the fixture
 * test; there is no external configuration (YAGNI).
 */
import { readingStatusOf, type ReadingStatus } from "../reading/ReadingStatus.js";

/** One retrieved passage, as the ranking sees it. */
export interface RankingHit {
  passageId: number;
  bookId: string;
  /** Normalized by `PassageSearch` so the best hit of a turn is 1. */
  score: number;
  text: string;
  page: number | null;
  section: string | null;
}

/** Candidate metadata; `from*` tells where the candidate was found. */
export interface RankingBook {
  bookId: string;
  title: string;
  author: string;
  format: "pdf" | "epub";
  language: string | null;
  series: string | null;
  description: string | null;
  tags: readonly string[];
  hasCover: boolean;
  coverRev: number | null;
  /** Stored reading fraction, clamped by the caller. */
  percentage: number;
  fromPassages: boolean;
  fromMetadata: boolean;
}

export interface RankedBook extends RankingBook {
  finalScore: number;
  matched: string[];
  evidence: RankingHit[];
  status: ReadingStatus;
}

/** At most five candidates; the model recommends at most three of them. */
export const MAX_RECOMMENDATIONS = 5;
export const MAX_EVIDENCE_PER_BOOK = 2;
/** Best three hits, decreasing, so a large book cannot win on volume alone. */
export const PASSAGE_WEIGHTS = [1, 0.5, 0.25] as const;
export const PASSAGE_SCORE_WEIGHT = 0.7;
export const COVERAGE_WEIGHT = 0.3;
export const RANK_PASSAGE_WEIGHT = 0.65;
export const RANK_METADATA_WEIGHT = 0.35;
export const FINISHED_FACTOR = 0.85;
export const MIN_FINAL_SCORE = 0.25;
export const MIN_RELATIVE_SCORE = 0.3;
/** A book found only by metadata needs most of the question in its metadata. */
export const METADATA_ONLY_MIN_MATCH = 0.6;
/** The shortlist shows at most six matched terms per card. */
export const MAX_MATCHED_TERMS = 6;

const STATUS_ORDER: Record<ReadingStatus, number> = { unread: 0, reading: 1, finished: 2 };

export function rankBookCandidates(input: {
  hits: readonly RankingHit[];
  books: readonly RankingBook[];
  terms: readonly string[];
}): RankedBook[] {
  const { hits, books, terms } = input;
  if (books.length === 0) return [];

  const hitsByBook = new Map<string, RankingHit[]>();
  for (const hit of hits) {
    const list = hitsByBook.get(hit.bookId);
    if (list) list.push(hit);
    else hitsByBook.set(hit.bookId, [hit]);
  }
  const totalHits = hits.length;
  const passageScores = new Map<string, number>();
  const coverage = new Map<string, number>();
  for (const [bookId, list] of hitsByBook) {
    const best = list.map((hit) => hit.score).sort((a, b) => b - a).slice(0, PASSAGE_WEIGHTS.length);
    const score = best.reduce((sum, value, index) => sum + value * PASSAGE_WEIGHTS[index]!, 0);
    passageScores.set(bookId, score);
    coverage.set(bookId, totalHits > 0 ? list.length / totalHits : 0);
  }
  const maxPassage = Math.max(0, ...passageScores.values());
  const maxCoverage = Math.max(0, ...coverage.values());
  const normalizedTerms = terms.map((term) => ({ original: term, normalized: normalizeForMatch(term) }))
    .filter((term) => term.normalized.length > 0);

  const scored = books.map((book) => {
    const passage = passageScores.get(book.bookId) ?? 0;
    const share = coverage.get(book.bookId) ?? 0;
    const passagePart = maxPassage > 0 && maxCoverage > 0
      ? PASSAGE_SCORE_WEIGHT * (passage / maxPassage) + COVERAGE_WEIGHT * (share / maxCoverage)
      : 0;
    const metadata = matchMetadata(book, normalizedTerms);
    const metadataPart = normalizedTerms.length > 0 ? metadata.weight / normalizedTerms.length : 0;
    const status = readingStatusOf(book.percentage);
    const factor = status === "finished" ? FINISHED_FACTOR : 1;
    const finalScore = (RANK_PASSAGE_WEIGHT * passagePart + RANK_METADATA_WEIGHT * metadataPart) * factor;
    const evidence = (hitsByBook.get(book.bookId) ?? [])
      .slice()
      .sort((a, b) => b.score - a.score || a.passageId - b.passageId)
      .slice(0, MAX_EVIDENCE_PER_BOOK);
    return { ...book, finalScore, metadataScore: metadataPart, matched: metadata.matched, evidence, status };
  });

  const best = Math.max(0, ...scored.map((book) => book.finalScore));
  if (best <= 0) return [];
  const cutoff = Math.max(MIN_FINAL_SCORE, MIN_RELATIVE_SCORE * best);
  return scored
    .filter((book) => {
      if (book.finalScore < cutoff) return false;
      if (book.fromMetadata && !book.fromPassages && book.metadataScore < METADATA_ONLY_MIN_MATCH) return false;
      return true;
    })
    .sort(compareCandidates)
    .slice(0, MAX_RECOMMENDATIONS)
    .map(({ metadataScore: _metadataScore, ...book }) => book);
}

function compareCandidates(a: RankedBook, b: RankedBook): number {
  if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore;
  const status = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (status !== 0) return status;
  const left = a.title.toLowerCase();
  const right = b.title.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.bookId < b.bookId ? -1 : a.bookId > b.bookId ? 1 : 0;
}

interface MetadataMatch {
  /** Sum of per-term weights: title/series count 1, author/tags/description/language 0.5. */
  weight: number;
  matched: string[];
}

interface RankingTerm {
  original: string;
  normalized: string;
}

function matchMetadata(book: RankingBook, terms: readonly RankingTerm[]): MetadataMatch {
  if (terms.length === 0) return { weight: 0, matched: [] };
  const titleText = normalizeForMatch(`${book.title} ${book.series ?? ""}`);
  const titleWords = wordSet(titleText);
  const otherText = normalizeForMatch([
    book.author,
    ...book.tags,
    book.description ?? "",
    book.language ?? "",
  ].join(" "));
  const otherWords = wordSet(otherText);
  let weight = 0;
  const matched: string[] = [];
  for (const term of terms) {
    const strong = fieldMatches(titleText, titleWords, term.normalized);
    const weak = !strong && fieldMatches(otherText, otherWords, term.normalized);
    if (!strong && !weak) continue;
    weight += strong ? 1 : 0.5;
    if (matched.length < MAX_MATCHED_TERMS) matched.push(term.original);
  }
  return { weight, matched };
}

/**
 * Terms of one or two characters only match a whole word: `C`, `R` and `Go` are real
 * topics while the same letters appear inside most words. Longer terms may match a
 * prefix or a substring, which covers "program" in "programming".
 */
function fieldMatches(text: string, words: ReadonlySet<string>, term: string): boolean {
  if (term.length <= 2) return words.has(term);
  return text.includes(term);
}

function wordSet(text: string): Set<string> {
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
