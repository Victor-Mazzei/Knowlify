import { describe, expect, it } from "vitest";
import { describeVectorPolicy, formatRate, formatTimeLeft, formatWorkers } from "./indexStatusText";

describe("index status text", () => {
  it("turns seconds into a short remaining-time phrase", () => {
    expect(formatTimeLeft(10)).toBe("less than a minute left");
    expect(formatTimeLeft(90)).toBe("about 2 min left");
    expect(formatTimeLeft(1800)).toBe("about 30 min left");
    expect(formatTimeLeft(10_800)).toBe("about 3 h left");
    expect(formatTimeLeft(172_800)).toBe("about 2 d left");
  });

  it("hides unknown or finished time estimates", () => {
    expect(formatTimeLeft(null)).toBeNull();
    expect(formatTimeLeft(undefined)).toBeNull();
    expect(formatTimeLeft(0)).toBeNull();
    expect(formatTimeLeft(Number.NaN)).toBeNull();
    expect(formatTimeLeft(-20)).toBeNull();
  });

  it("reports passages per minute with readable grouping", () => {
    expect(formatRate(24)).toBe("1,440 passages/min");
    expect(formatRate(0.5)).toBe("30 passages/min");
    expect(formatRate(0.008)).toBe("0.5 passages/min");
    expect(formatRate(0)).toBeNull();
    expect(formatRate(null)).toBeNull();
    expect(formatRate(undefined)).toBeNull();
  });

  it("names the worker count", () => {
    expect(formatWorkers(1)).toBe("1 worker");
    expect(formatWorkers(3)).toBe("3 workers");
    expect(formatWorkers(0)).toBeNull();
    expect(formatWorkers(undefined)).toBeNull();
  });

  it("explains the vector budget and the on-demand mode", () => {
    expect(describeVectorPolicy({ mode: "auto", maxBooks: 1000 })).toBe("First 1,000 books; others on demand.");
    expect(describeVectorPolicy({ mode: "demand", maxBooks: 0 })).toBe("On demand only.");
    expect(describeVectorPolicy({ mode: "auto", maxBooks: 0 })).toBe("On demand only.");
  });
});
