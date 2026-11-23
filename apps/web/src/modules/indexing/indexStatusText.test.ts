import { describe, expect, it } from "vitest";
import { retrievalStatus } from "./fixtures";
import {
  describeRetrieval,
  describeVectorPolicy,
  formatCacheSize,
  formatRate,
  formatTimeLeft,
  formatWorkers,
  warmupPercent,
} from "./indexStatusText";
import type { IndexWarmupReason } from "./types";

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

describe("retrieval status text", () => {
  it("names every warm-up state in plain language", () => {
    const state = (overrides: Parameters<typeof retrievalStatus>[0]) =>
      describeRetrieval(retrievalStatus(overrides))?.stateText;
    expect(state({ warmup: { state: "off", reason: "small-index" } })).toBe("Off (small index)");
    expect(state({ warmup: { state: "off", reason: "low-memory" } })).toBe("Off (limited memory)");
    expect(state({ warmup: { state: "off", reason: "over-budget" } })).toBe("Off (index too large)");
    expect(state({ warmup: { state: "off", reason: "disabled" } })).toBe("Off (turned off)");
    expect(state({ warmup: { state: "idle" } })).toBe("Idle");
    expect(state({ warmup: { state: "waiting" } })).toBe("Waiting for a quiet moment");
    expect(state({ warmup: { state: "warming" } })).toBe("Warming the search index…");
    expect(state({ warmup: { state: "warm" } })).toBe("Warm");
    expect(state({ warmup: { state: "paused", reason: "activity" } })).toBe("Paused (busy)");
    expect(state({ warmup: { state: "paused", reason: "memory-pressure" } })).toBe("Paused (limited memory)");
  });

  it("keeps an unknown reason readable", () => {
    const reason = "future-reason" as IndexWarmupReason;
    expect(describeRetrieval(retrievalStatus({ warmup: { state: "off", reason } }))?.stateText).toBe(
      "Off (unknown reason)",
    );
  });

  it("clamps the warm-up percentage to 0–100", () => {
    const percent = (warmedMB: number, targetMB: number) =>
      warmupPercent(retrievalStatus({ warmup: { state: "warming", warmedMB, targetMB } }).warmup);
    expect(percent(30, 120)).toBe(25);
    expect(percent(300, 120)).toBe(100);
    expect(percent(-30, 120)).toBe(0);
    expect(percent(30, 0)).toBeNull();
    expect(percent(Number.NaN, 120)).toBeNull();
    expect(warmupPercent(retrievalStatus({ warmup: { state: "warm" } }).warmup)).toBeNull();
  });

  it("formats the cache size and the short hint", () => {
    expect(formatCacheSize(0)).toBe("0 KB");
    expect(formatCacheSize(512)).toBe("512 KB");
    expect(formatCacheSize(1536)).toBe("1.5 MB");
    expect(formatCacheSize(Number.NaN)).toBeNull();
    const summary = describeRetrieval(retrievalStatus());
    expect(summary?.cacheText).toBe("Cache: 1.5 MB of 8 MB");
    expect(summary?.cacheHint).toBe("Faster repeated searches");
  });

  it("shows the cache as off without the hint", () => {
    const summary = describeRetrieval(retrievalStatus({ cache: { enabled: false } }));
    expect(summary?.cacheText).toBe("Cache: off");
    expect(summary?.cacheHint).toBeNull();
  });
});
