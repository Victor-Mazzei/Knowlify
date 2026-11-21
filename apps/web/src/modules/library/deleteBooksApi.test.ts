import { describe, expect, it } from "vitest";
import { ApiError } from "../../services/api";
import {
  parseDeletePartial,
  partialMessage,
  remainingSelection,
  removedIdsOf,
} from "./deleteBooksApi";

const conflict = (details: Record<string, unknown>) =>
  new ApiError(409, "changed", "selection_changed", details);

describe("deleteBooksApi", () => {
  it("only treats a conflict with committed blocks as partial", () => {
    expect(parseDeletePartial(new Error("offline"))).toBeNull();
    expect(parseDeletePartial(new ApiError(409, "changed", "other_code", { removed: 1 }))).toBeNull();
    expect(parseDeletePartial(conflict({ total: 3 }))).toBeNull();
    expect(parseDeletePartial(conflict({ removed: 2, remainingIds: ["a", 1], remainingTotal: 4 }))).toEqual({
      removed: 2,
      remainingIds: ["a"],
      remainingTotal: 4,
    });
    // The first block can be blocked before any deletion; the remainder still lets
    // the client review again.
    expect(parseDeletePartial(conflict({ removed: 0, remainingIds: ["a", "b"] }))).toEqual({
      removed: 0,
      remainingIds: ["a", "b"],
    });
  });

  it("derives the remaining explicit id selection", () => {
    const current = { ids: ["a", "b", "c"] };
    const partial = parseDeletePartial(conflict({ removed: 1, remainingIds: ["b", "c"] }));
    expect(partial).not.toBeNull();
    expect(removedIdsOf(current, partial!)).toEqual(["a"]);
    expect(remainingSelection(current, partial!)).toEqual({ ids: ["b", "c"] });

    const unknownRemainder = parseDeletePartial(conflict({ removed: 1 }));
    expect(removedIdsOf(current, unknownRemainder!)).toBeUndefined();
    expect(remainingSelection(current, unknownRemainder!)).toEqual({ ids: ["a", "b", "c"] });
    expect(remainingSelection({ ids: ["a"] }, parseDeletePartial(conflict({ removed: 1, remainingIds: [] }))!)).toBeNull();
  });

  it("uses remainingTotal for filters and falls back to the previous total", () => {
    const current = { filter: { format: "pdf" as const }, expectedTotal: 5 };
    expect(remainingSelection(current, { removed: 2, remainingTotal: 3 })).toEqual({
      filter: { format: "pdf" },
      expectedTotal: 3,
    });
    expect(remainingSelection(current, { removed: 2 })).toEqual({
      filter: { format: "pdf" },
      expectedTotal: 3,
    });
    expect(remainingSelection(current, { removed: 5 })).toBeNull();
  });

  it("announces the count that changed and the remainder", () => {
    expect(partialMessage(5, 2, 3)).toBe(
      "Deleted 2 of 5. 3 books changed (new notes) and were not deleted — review again.",
    );
    expect(partialMessage(2, 1, 1)).toBe(
      "Deleted 1 of 2. 1 book changed (new notes) and was not deleted — review again.",
    );
  });
});
