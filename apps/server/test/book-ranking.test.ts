import { describe, expect, it } from "vitest";
import {
  MAX_RECOMMENDATIONS,
  rankBookCandidates,
  type RankingBook,
  type RankingHit,
} from "../src/domain/assistant/bookRanking.js";

function hit(bookId: string, score: number, passageId = 1): RankingHit {
  return { passageId, bookId, score, text: `passage ${passageId}`, page: 1, section: null };
}

function book(overrides: Partial<RankingBook> & Pick<RankingBook, "bookId">): RankingBook {
  return {
    title: "Untitled",
    author: "Author",
    format: "epub",
    language: null,
    series: null,
    description: null,
    tags: [],
    hasCover: false,
    coverRev: null,
    percentage: 0,
    fromPassages: true,
    fromMetadata: false,
    ...overrides,
  };
}

describe("rankBookCandidates", () => {
  it("aggregates the best three hits with decreasing weights", () => {
    const ranked = rankBookCandidates({
      hits: [
        hit("a", 1, 1), hit("a", 0.8, 2), hit("a", 0.6, 3), hit("a", 0.4, 4),
        hit("b", 0.9, 5),
      ],
      books: [book({ bookId: "a" }), book({ bookId: "b" })],
      terms: [],
    });
    expect(ranked.map((item) => item.bookId)).toEqual(["a", "b"]);
    // 1 + 0.5*0.8 + 0.25*0.6 = 1.55; the fourth hit is ignored.
    expect(ranked[0]?.finalScore).toBeGreaterThan(ranked[1]?.finalScore ?? 0);
  });

  it("rewards coverage across the retrieved hits", () => {
    const ranked = rankBookCandidates({
      hits: [hit("a", 1, 1), hit("a", 0.2, 2), hit("b", 0.9, 3), hit("b", 0.9, 4)],
      books: [book({ bookId: "a" }), book({ bookId: "b" })],
      terms: [],
    });
    // Both cover half of the hits, but b has a higher decreasing sum.
    expect(ranked[0]?.bookId).toBe("b");
  });

  it("scores a title match above an author match and keeps the original term", () => {
    const ranked = rankBookCandidates({
      hits: [],
      books: [
        book({ bookId: "title", title: "Rust for Web", fromPassages: false, fromMetadata: true }),
        book({ bookId: "author", author: "Rust Expert", fromPassages: false, fromMetadata: true }),
      ],
      terms: ["Rust", "Web"],
    });
    expect(ranked.map((item) => item.bookId)).toEqual(["title"]);
    expect(ranked[0]?.matched).toEqual(["Rust", "Web"]);
  });

  it("drops a metadata-only book whose metadata covers less than 60% of the terms", () => {
    const ranked = rankBookCandidates({
      hits: [],
      books: [book({ bookId: "partial", title: "Rust", fromPassages: false, fromMetadata: true })],
      terms: ["rust", "web"],
    });
    expect(ranked).toEqual([]);
  });

  it("keeps a metadata-only book with a strong title match", () => {
    const ranked = rankBookCandidates({
      hits: [],
      books: [book({ bookId: "title", title: "Rust for Web", fromPassages: false, fromMetadata: true })],
      terms: ["rust", "web"],
    });
    expect(ranked.map((item) => item.bookId)).toEqual(["title"]);
    expect(ranked[0]?.evidence).toEqual([]);
  });

  it("applies the absolute and relative cuts", () => {
    const ranked = rankBookCandidates({
      hits: [hit("best", 1, 1), hit("close", 0.253, 2), hit("far", 0.209, 3)],
      books: [
        book({ bookId: "best", title: "Rust", fromMetadata: true }),
        book({ bookId: "close" }),
        book({ bookId: "far" }),
      ],
      terms: ["rust"],
    });
    // best: 0.65*1 + 0.35*1 = 1.0; cutoff = 0.30. close: 0.65*(0.7*0.253+0.3) = 0.310;
    // far: 0.65*(0.7*0.209+0.3) = 0.290.
    expect(ranked.map((item) => item.bookId)).toEqual(["best", "close"]);
  });

  it("drops everything below the absolute cut", () => {
    const ranked = rankBookCandidates({
      hits: [hit("best", 1, 1), hit("weak", 0.1, 2)],
      books: [book({ bookId: "best" }), book({ bookId: "weak" })],
      terms: [],
    });
    // weak: 0.65*(0.7*0.1+0.3) = 0.2405 < 0.25.
    expect(ranked.map((item) => item.bookId)).toEqual(["best"]);
  });

  it("ranks an unread book above a finished book with equal relevance", () => {
    const ranked = rankBookCandidates({
      hits: [hit("finished", 1, 1), hit("unread", 1, 2)],
      books: [
        book({ bookId: "finished", title: "Rust A", percentage: 1 }),
        book({ bookId: "unread", title: "Rust B", percentage: 0 }),
      ],
      terms: ["rust"],
    });
    expect(ranked.map((item) => item.bookId)).toEqual(["unread", "finished"]);
  });

  it("breaks a tie by reading status and then by title", () => {
    const tied = rankBookCandidates({
      hits: [hit("reading", 1, 1), hit("unread", 1, 2)],
      books: [
        book({ bookId: "reading", title: "Alpha", percentage: 0.4 }),
        book({ bookId: "unread", title: "Beta", percentage: 0 }),
      ],
      terms: [],
    });
    expect(tied.map((item) => item.bookId)).toEqual(["unread", "reading"]);

    const byTitle = rankBookCandidates({
      hits: [hit("beta", 1, 1), hit("alpha", 1, 2)],
      books: [
        book({ bookId: "beta", title: "Beta" }),
        book({ bookId: "alpha", title: "Alpha" }),
      ],
      terms: [],
    });
    expect(byTitle.map((item) => item.bookId)).toEqual(["alpha", "beta"]);
  });

  it("keeps at most five candidates and two best evidence passages per book", () => {
    const books = Array.from({ length: 7 }, (_, index) => book({ bookId: `b${index}` }));
    const hits = books.flatMap((item, index) => [
      hit(item.bookId, 1 - index * 0.01, index * 10 + 1),
      hit(item.bookId, 0.9 - index * 0.01, index * 10 + 2),
      hit(item.bookId, 0.8 - index * 0.01, index * 10 + 3),
    ]);
    const ranked = rankBookCandidates({ hits, books, terms: [] });
    expect(ranked).toHaveLength(MAX_RECOMMENDATIONS);
    expect(ranked[0]?.evidence.map((item) => item.passageId)).toEqual([1, 2]);
  });

  it("is deterministic regardless of input order", () => {
    const hits = [hit("a", 0.7, 1), hit("b", 0.9, 2), hit("a", 0.6, 3)];
    const books = [book({ bookId: "a", title: "Rust" }), book({ bookId: "b", title: "Rust" })];
    const first = rankBookCandidates({ hits, books, terms: ["rust"] });
    const second = rankBookCandidates({ hits: [...hits].reverse(), books: [...books].reverse(), terms: ["rust"] });
    expect(second.map((item) => item.bookId)).toEqual(first.map((item) => item.bookId));
    expect(second.map((item) => item.finalScore)).toEqual(first.map((item) => item.finalScore));
  });

  it("returns nothing without candidates", () => {
    expect(rankBookCandidates({ hits: [], books: [], terms: ["rust"] })).toEqual([]);
  });
});
