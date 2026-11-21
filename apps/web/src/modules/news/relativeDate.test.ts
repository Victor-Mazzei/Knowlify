import { describe, expect, it } from "vitest";
import { relativeDate } from "./relativeDate";

describe("relativeDate", () => {
  const now = Date.parse("2026-01-02T12:00:00.000Z");

  it("formats minutes, hours, days, and invalid dates", () => {
    expect(relativeDate("2026-01-02T11:58:00.000Z", now)).toBe("2 m ago");
    expect(relativeDate("2026-01-02T09:00:00.000Z", now)).toBe("3 h ago");
    expect(relativeDate("2025-12-30T12:00:00.000Z", now)).toBe("3 d ago");
    expect(relativeDate("not-a-date", now)).toBe("Date unknown");
    expect(relativeDate(undefined, now)).toBe("Date unknown");
  });
});
