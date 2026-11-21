import { describe, expect, it } from "vitest";
import {
  chunkSections,
  failure,
  indexing,
  MAX_ATTEMPTS,
  ready,
  RETRY_DELAYS_MS,
  unchanged,
  type BookIndex,
  type TextSection,
} from "../src/domain/knowledge/BookIndex.js";

const index = (overrides: Partial<BookIndex> = {}): BookIndex => ({
  bookId: "book",
  state: "indexing",
  priority: 1,
  contentHash: null,
  indexVersion: null,
  fingerprint: null,
  chunkCount: 0,
  attempts: 0,
  nextAttemptAt: 0,
  error: null,
  requestedAt: 1,
  startedAt: 2,
  finishedAt: null,
  ...overrides,
});

const sections = (text: string, metadata: Partial<TextSection> = {}): TextSection[] =>
  [{ text, page: null, section: null, ...metadata }];

describe("chunkSections", () => {
  it("keeps short sections intact and preserves location metadata", () => {
    const chunks = [...chunkSections(sections("short text", { page: 7, section: "Chapter 1" }))];
    expect(chunks).toEqual([{ ordinal: 0, text: "short text", page: 7, section: "Chapter 1" }]);
  });

  it("splits long text within the size limit, overlapping windows and never skipping content", () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const chunks = [...chunkSections(sections(words), { size: 300, overlap: 50 })];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(300);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, i) => i));
    // Every word appears, in order, across the chunks.
    const flat = chunks.map((chunk) => chunk.text).join(" ");
    for (const word of ["word0", "word100", "word599"]) expect(flat).toContain(word);
    const lastOfFirst = chunks[0]!.text.split(" ").at(-1)!;
    expect(chunks[1]!.text).toContain(lastOfFirst);
  });

  it("prefers paragraph and sentence boundaries", () => {
    const paragraph = `${"a".repeat(400)}.\n\n${"b".repeat(400)}.`;
    const chunks = [...chunkSections(sections(paragraph), { size: 500, overlap: 50 })];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe(`${"a".repeat(400)}.`);
    expect(chunks[1]!.text.endsWith(".")).toBe(true);
    expect(chunks[1]!.text).toContain("b".repeat(400));
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(500);
  });

  it("never crosses sections and skips empty ones", () => {
    const chunks = [...chunkSections([
      { text: "first section", page: 1, section: "one" },
      { text: "   ", page: 2, section: "ignored" },
      { text: "second section", page: 3, section: "two" },
    ])];
    expect(chunks).toEqual([
      { ordinal: 0, text: "first section", page: 1, section: "one" },
      { ordinal: 1, text: "second section", page: 3, section: "two" },
    ]);
  });

  it("clamps pathological options instead of looping", () => {
    const chunks = [...chunkSections(sections("abcdefghij"), { size: 4, overlap: 999 })];
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(4);
  });
});

describe("failure policy", () => {
  it("marks missing text and oversized books as terminal immediately", () => {
    for (const code of ["no_text", "too_large"] as const) {
      const failed = failure(index(), code, "reason", 1_000);
      expect(failed).toMatchObject({ state: "error", attempts: 1, error: { code, message: "reason" }, finishedAt: 1_000 });
    }
  });

  it("backs off transient failures and stops after MAX_ATTEMPTS", () => {
    const first = failure(index(), "unreadable", "smb down", 1_000);
    expect(first).toMatchObject({ state: "pending", attempts: 1, nextAttemptAt: 1_000 + RETRY_DELAYS_MS[0], error: null });
    const second = failure(first, "unknown", "still down", 2_000);
    expect(second).toMatchObject({ state: "pending", attempts: 2, nextAttemptAt: 2_000 + RETRY_DELAYS_MS[1] });
    const third = failure(second, "unknown", "gave up", 3_000);
    expect(third).toMatchObject({ state: "error", attempts: MAX_ATTEMPTS, error: { code: "unknown", message: "gave up" } });
  });

  it("resets bookkeeping on success", () => {
    const failed = failure(index({ attempts: 2 }), "unknown", "x", 1_000);
    const done = ready(failed, { contentHash: "hash", indexVersion: "1|none", chunkCount: 4 }, 2_000);
    expect(done).toMatchObject({ state: "ready", attempts: 0, contentHash: "hash", indexVersion: "1|none", chunkCount: 4, error: null, finishedAt: 2_000 });
    const kept = unchanged(index({ chunkCount: 9 }), { contentHash: "hash", indexVersion: "1|none" }, 3_000);
    expect(kept).toMatchObject({ state: "ready", chunkCount: 9, finishedAt: 3_000 });
    expect(indexing(index(), 5_000)).toMatchObject({ state: "indexing", startedAt: 5_000, finishedAt: null });
  });
});
