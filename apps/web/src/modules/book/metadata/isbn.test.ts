import { describe, expect, it } from "vitest";
import { isbnKind, isValidIsbn10, isValidIsbn13, normalizeIsbn, preferredIsbn } from "./isbn";

describe("ISBN helpers", () => {
  it("normalizes separators and check letters", () => {
    expect(normalizeIsbn("978-0-306-40615-7")).toBe("9780306406157");
    expect(normalizeIsbn("0 8044 2957 x")).toBe("080442957X");
  });

  it("validates ISBN-10 check digits, including X", () => {
    expect(isValidIsbn10("0306406152")).toBe(true);
    expect(isValidIsbn10("0-8044-2957-X")).toBe(true);
    expect(isValidIsbn10("0306406153")).toBe(false);
    expect(isValidIsbn10("123")).toBe(false);
  });

  it("validates ISBN-13 check digits", () => {
    expect(isValidIsbn13("978-0-306-40615-7")).toBe(true);
    expect(isValidIsbn13("9780140449136")).toBe(true);
    expect(isValidIsbn13("9780306406158")).toBe(false);
    expect(isValidIsbn13("978030640615X")).toBe(false);
  });

  it("classifies a usable value and prefers the 13-digit form", () => {
    expect(isbnKind("0306406152")).toBe("isbn10");
    expect(isbnKind("9780306406157")).toBe("isbn13");
    expect(isbnKind("nope")).toBeNull();
    expect(preferredIsbn({ isbn10: "0306406152", isbn13: "9780306406157" })).toEqual({
      kind: "isbn13",
      value: "9780306406157",
    });
    expect(preferredIsbn({ isbn10: "0306406152", isbn13: "invalid" })).toEqual({
      kind: "isbn10",
      value: "0306406152",
    });
    expect(preferredIsbn({ isbn10: null, isbn13: null })).toBeNull();
  });
});
