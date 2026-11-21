import { describe, expect, it } from "vitest";
import { clipExcerpt, withExcerpt } from "./excerpt";

describe("excerpt", () => {
  it("normalizes whitespace and caps the text at 2000 characters", () => {
    expect(clipExcerpt("  one\n two \t three  ")).toBe("one two three");
    const clipped = clipExcerpt("a".repeat(2500));
    expect(clipped).toHaveLength(2000);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("only adds excerpt fields to book scope, capping the section", () => {
    expect(withExcerpt({ kind: "library" }, { text: "ignored", kind: "selection" })).toEqual({ kind: "library" });

    const scope = withExcerpt(
      { kind: "book", bookId: "b1" },
      { text: "passage", kind: "visible", page: 4, section: "s".repeat(250) },
    );
    expect(scope).toMatchObject({ kind: "book", bookId: "b1", excerpt: "passage", excerptKind: "visible", page: 4 });
    expect(scope.kind === "book" ? scope.section : "").toHaveLength(200);
  });

  it("omits an empty excerpt", () => {
    expect(withExcerpt({ kind: "book", bookId: "b1" }, { text: "   ", kind: "selection" })).toEqual({
      kind: "book",
      bookId: "b1",
    });
  });
});
