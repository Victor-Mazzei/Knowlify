import { describe, expect, it } from "vitest";
import {
  isValidIsbn10,
  isValidIsbn13,
  maxMetadataYear,
  MetadataDisabledError,
  normalizeLookupQuery,
  normalizeMetadataPatch,
  stripIsbn,
} from "../src/domain/library/BookMetadata.js";
import { ValidationError } from "../src/domain/errors.js";

const MAX_YEAR = 2027;

const fieldOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).details?.field as string | undefined;
  }
  throw new Error("expected a ValidationError");
};

describe("metadata domain validation", () => {
  it("validates ISBN-10 and ISBN-13 checksums", () => {
    expect(isValidIsbn10(stripIsbn("0-13-235088-2"))).toBe(true);
    expect(isValidIsbn10("080442957X")).toBe(true);
    expect(isValidIsbn10("0132350883")).toBe(false);
    expect(isValidIsbn13(stripIsbn("978-0-13-235088-4"))).toBe(true);
    expect(isValidIsbn13("9780132350885")).toBe(false);
    expect(isValidIsbn13("1234567890123")).toBe(false);
  });

  it("normalizes a patch (NFC, trim) and validates limits", () => {
    expect(normalizeMetadataPatch({
      title: "  Clean   Code  ",
      author: "",
      description: "line 1\r\nline 2",
      isbn10: "0-13-235088-2",
      isbn13: "978-0-13-235088-4",
      year: 2008,
      publisher: "Prentice Hall",
      language: "EN-us",
      series: "Robert C. Martin Series",
      seriesIndex: 2.5,
      source: "googlebooks",
    }, MAX_YEAR)).toEqual({
      title: "Clean   Code",
      author: "",
      description: "line 1\nline 2",
      isbn10: "0132350882",
      isbn13: "9780132350884",
      year: 2008,
      publisher: "Prentice Hall",
      language: "en-us",
      series: "Robert C. Martin Series",
      seriesIndex: 2.5,
      source: "googlebooks",
    });
    expect(normalizeMetadataPatch({ title: "e\u0301" }, MAX_YEAR).title).toBe("é");
    expect(normalizeMetadataPatch({ title: null }, MAX_YEAR)).toEqual({ title: null });
  });

  it("rejects unknown fields, empty bodies and invalid values with a field", () => {
    expect(fieldOf(() => normalizeMetadataPatch({ nope: 1 }, MAX_YEAR))).toBe("nope");
    expect(fieldOf(() => normalizeMetadataPatch({}, MAX_YEAR))).toBe("body");
    expect(fieldOf(() => normalizeMetadataPatch({ source: "manual" }, MAX_YEAR))).toBe("body");
    expect(fieldOf(() => normalizeMetadataPatch({ title: "   " }, MAX_YEAR))).toBe("title");
    expect(fieldOf(() => normalizeMetadataPatch({ title: "x".repeat(301) }, MAX_YEAR))).toBe("title");
    expect(fieldOf(() => normalizeMetadataPatch({ title: "bad\u0007" }, MAX_YEAR))).toBe("title");
    expect(fieldOf(() => normalizeMetadataPatch({ author: "a".repeat(201) }, MAX_YEAR))).toBe("author");
    expect(fieldOf(() => normalizeMetadataPatch({ description: "x".repeat(5001) }, MAX_YEAR))).toBe("description");
    expect(fieldOf(() => normalizeMetadataPatch({ publisher: "" }, MAX_YEAR))).toBe("publisher");
    expect(fieldOf(() => normalizeMetadataPatch({ isbn10: "0132350883" }, MAX_YEAR))).toBe("isbn10");
    expect(fieldOf(() => normalizeMetadataPatch({ isbn13: "9780132350884x" }, MAX_YEAR))).toBe("isbn13");
    expect(fieldOf(() => normalizeMetadataPatch({ year: 0 }, MAX_YEAR))).toBe("year");
    expect(fieldOf(() => normalizeMetadataPatch({ year: MAX_YEAR + 1 }, MAX_YEAR))).toBe("year");
    expect(fieldOf(() => normalizeMetadataPatch({ year: 2008.5 }, MAX_YEAR))).toBe("year");
    expect(fieldOf(() => normalizeMetadataPatch({ language: "english" }, MAX_YEAR))).toBe("language");
    expect(fieldOf(() => normalizeMetadataPatch({ language: "en_US" }, MAX_YEAR))).toBe("language");
    expect(fieldOf(() => normalizeMetadataPatch({ series: "s".repeat(201) }, MAX_YEAR))).toBe("series");
    expect(fieldOf(() => normalizeMetadataPatch({ seriesIndex: 10000 }, MAX_YEAR))).toBe("seriesIndex");
    expect(fieldOf(() => normalizeMetadataPatch({ seriesIndex: 1.234 }, MAX_YEAR))).toBe("seriesIndex");
    expect(fieldOf(() => normalizeMetadataPatch({ source: "web" }, MAX_YEAR))).toBe("source");
    expect(fieldOf(() => normalizeMetadataPatch({ source: 1 }, MAX_YEAR))).toBe("source");
    expect(fieldOf(() => normalizeMetadataPatch(null, MAX_YEAR))).toBe("body");
    expect(fieldOf(() => normalizeMetadataPatch([], MAX_YEAR))).toBe("body");
  });

  it("supports multi-line descriptions but no control characters", () => {
    expect(normalizeMetadataPatch({ description: "a\nb\n\nc" }, MAX_YEAR).description).toBe("a\nb\n\nc");
    expect(fieldOf(() => normalizeMetadataPatch({ description: "a\tb" }, MAX_YEAR))).toBe("description");
  });

  it("validates lookup queries: ISBN xor title, checksums included", () => {
    expect(normalizeLookupQuery({ isbn: "978-0-13-235088-4" })).toEqual({ isbn: "9780132350884" });
    expect(normalizeLookupQuery({ isbn: "0-13-235088-2" })).toEqual({ isbn: "0132350882" });
    expect(normalizeLookupQuery({ title: " Clean Code ", author: " Martin " }))
      .toEqual({ title: "Clean Code", author: "Martin" });
    expect(normalizeLookupQuery({ title: "Clean Code", author: "  " })).toEqual({ title: "Clean Code" });
    expect(fieldOf(() => normalizeLookupQuery({ isbn: "0132350884" }))).toBe("isbn");
    expect(fieldOf(() => normalizeLookupQuery({ isbn: "9780132350884", title: "x" }))).toBe("query");
    expect(fieldOf(() => normalizeLookupQuery({ title: "" }))).toBe("title");
    expect(fieldOf(() => normalizeLookupQuery({ title: "x".repeat(201) }))).toBe("title");
    expect(fieldOf(() => normalizeLookupQuery({}))).toBe("query");
    expect(fieldOf(() => normalizeLookupQuery({ author: "x" }))).toBe("query");
  });

  it("caps the year at next year and exposes the disabled error contract", () => {
    expect(maxMetadataYear(Date.UTC(2026, 10, 20))).toBe(2027);
    const error = new MetadataDisabledError();
    expect(error.status).toBe(403);
    expect(error.code).toBe("lookup_disabled");
  });
});
