import { describe, expect, it } from "vitest";
import { formatRemaining } from "./readingProgress";
import { FINISHED_AT, UNSTARTED_BELOW, readingStatusOf } from "./readingStatus";

describe("readingStatusOf", () => {
  it("classifies missing and low progress as not started", () => {
    expect(readingStatusOf(null)).toBe("unread");
    expect(readingStatusOf(undefined)).toBe("unread");
    expect(readingStatusOf(0)).toBe("unread");
    expect(readingStatusOf(UNSTARTED_BELOW - 0.0001)).toBe("unread");
  });

  it("uses the same boundaries as the remaining label", () => {
    expect(readingStatusOf(UNSTARTED_BELOW)).toBe("reading");
    expect(readingStatusOf(0.5)).toBe("reading");
    expect(readingStatusOf(FINISHED_AT - 0.0001)).toBe("reading");
    expect(readingStatusOf(FINISHED_AT)).toBe("finished");
    expect(readingStatusOf(1)).toBe("finished");
  });

  it("agrees with formatRemaining at both boundaries", () => {
    expect(formatRemaining(UNSTARTED_BELOW - 0.0001)).toBeNull();
    expect(formatRemaining(UNSTARTED_BELOW)).not.toBeNull();
    expect(formatRemaining(FINISHED_AT - 0.0001)?.label).not.toBe("Finished");
    expect(formatRemaining(FINISHED_AT)?.label).toBe("Finished");
  });
});
