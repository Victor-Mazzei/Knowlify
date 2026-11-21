import { describe, expect, it } from "vitest";
import {
  FINISHED_AT,
  UNSTARTED_BELOW,
  readingStatusOf,
} from "../src/domain/reading/ReadingStatus.js";

describe("readingStatusOf", () => {
  it("pins the same thresholds the reader uses", () => {
    // apps/web/src/modules/library/readingProgress.ts rounds to the nearest percent and
    // treats the last percent as "Finished"; the backend copy must not drift.
    expect(UNSTARTED_BELOW).toBe(0.005);
    expect(FINISHED_AT).toBe(0.99);
  });

  it.each([
    [null, "unread"],
    [undefined, "unread"],
    [Number.NaN, "unread"],
    [-1, "unread"],
    [0, "unread"],
    [0.0049, "unread"],
    [0.005, "reading"],
    [0.5, "reading"],
    [0.9899, "reading"],
    [0.99, "finished"],
    [1, "finished"],
    [1.5, "finished"],
  ] as const)("classifies %s as %s", (percentage, expected) => {
    expect(readingStatusOf(percentage)).toBe(expected);
  });
});
