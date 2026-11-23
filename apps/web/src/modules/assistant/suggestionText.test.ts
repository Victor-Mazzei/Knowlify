import { describe, expect, it } from "vitest";
import { bookOpenLabel, matchesLabel, readingLabel, shortBookTitle } from "./suggestionText";
import type { RecommendedBook } from "./types";

const book = (overrides: Partial<RecommendedBook> = {}): RecommendedBook => ({
  n: 1,
  bookId: "b1",
  title: "Rust for Web Developers",
  author: "Mara Klein",
  format: "epub",
  language: "en",
  hasCover: false,
  coverRev: null,
  progress: { status: "unread", percentage: 0 },
  matched: ["rust", "web"],
  evidence: [
    { passageId: 1, page: 1, section: null },
    { passageId: 2, page: 2, section: null },
  ],
  source: "passages",
  ...overrides,
});

describe("suggestionText", () => {
  it("keeps a short title and truncates a long one", () => {
    expect(shortBookTitle("  Rust   for Web  ")).toBe("Rust for Web");
    const long = shortBookTitle("A".repeat(60));
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(44);
  });

  it("builds the one accessible name used by every book link", () => {
    expect(bookOpenLabel(book())).toBe("Open Rust for Web Developers by Mara Klein");
    expect(bookOpenLabel(book({ author: "" }))).toBe("Open Rust for Web Developers");
  });

  it("shows the reading state as text", () => {
    expect(readingLabel({ status: "unread", percentage: 0 })).toBe("Not read");
    expect(readingLabel({ status: "reading", percentage: 0.34 })).toBe("In progress 34%");
    expect(readingLabel({ status: "reading", percentage: 0.001 })).toBe("In progress 1%");
    expect(readingLabel({ status: "reading", percentage: 1 })).toBe("In progress 99%");
    expect(readingLabel({ status: "finished", percentage: 1 })).toBe("Finished");
  });

  it("explains why a book is listed", () => {
    expect(matchesLabel(book())).toBe("Matches: rust, web · 2 passages");
    expect(matchesLabel(book({ evidence: [book().evidence[0]!] }))).toBe("Matches: rust, web · 1 passage");
    expect(matchesLabel(book({ matched: [] }))).toBe("2 passages");
    expect(matchesLabel(book({ source: "metadata", matched: [] }))).toBe("Matches the title");
  });
});
