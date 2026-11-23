import { describe, expect, it } from "vitest";

import {
  planWarmup,
  WARMUP_DESKTOP_MIN_CACHEABLE_BYTES,
  WARMUP_MIN_CACHEABLE_BYTES,
  WARMUP_MIN_FILE_BYTES,
  WARMUP_MIN_HOT_BYTES,
  WARMUP_PARTIAL_MIN_CACHEABLE_BYTES,
  WARMUP_SMALL_MACHINE_LIMIT_BYTES,
  type WarmupPlanInput,
} from "../src/adapters/search/WarmupController.js";

const MB = 1024 * 1024;

const plan = (overrides: Partial<WarmupPlanInput>): ReturnType<typeof planWarmup> => planWarmup({
  mode: "auto",
  enabled: true,
  desktop: false,
  fileBytes: 1_200 * MB,
  hotBytes: 0,
  limitBytes: 4_096 * MB,
  cacheableBytes: 3_000 * MB,
  ...overrides,
});

/**
 * The policy is the safety boundary: it must never read on a small machine and must
 * choose the partial scope only when the metadata warm is worth competing with queries.
 */
describe("warm-up policy", () => {
  it("never warms when the operator turns it off or the index is disabled", () => {
    expect(plan({ mode: "off" })).toEqual({ start: false, targetBytes: 0 });
    expect(plan({ enabled: false })).toEqual({ start: false, reason: "disabled", targetBytes: 0 });
  });

  it("stays off for a small index or a small database file", () => {
    expect(plan({ fileBytes: WARMUP_MIN_FILE_BYTES - 1 }))
      .toEqual({ start: false, reason: "small-index", targetBytes: 0 });
    // W = 0.35 × 130 MB = 45.5 MB, below the 48 MB floor.
    expect(plan({ fileBytes: 130 * MB })).toEqual({ start: false, reason: "small-index", targetBytes: 0 });
  });

  it("lets `on` ignore the working-set floor but never the file floor", () => {
    // 200 MB × 0.35 = 70 MB: `auto` would warm it anyway; a 120 MB file stays off.
    expect(plan({ mode: "on", fileBytes: 120 * MB }))
      .toEqual({ start: false, reason: "small-index", targetBytes: 0 });
    const small = plan({ mode: "on", fileBytes: 200 * MB, hotBytes: 30 * MB, cacheableBytes: 2_000 * MB });
    expect(small).toMatchObject({ start: true, scope: "full" });
    expect(small.targetBytes).toBe(30 * MB);
  });

  it("turns off below 128 MB of usable memory", () => {
    expect(plan({ cacheableBytes: WARMUP_MIN_CACHEABLE_BYTES - 1 }))
      .toEqual({ start: false, reason: "low-memory", targetBytes: 0 });
  });

  it("is stricter on a shared machine (no cgroup limit) in auto mode", () => {
    const shared = plan({ desktop: true, cacheableBytes: 300 * MB, hotBytes: 70 * MB });
    expect(shared).toEqual({ start: false, reason: "low-memory", targetBytes: 0 });
    // `on` is an explicit operator choice and only keeps the memory guards.
    expect(plan({ mode: "on", desktop: true, cacheableBytes: WARMUP_DESKTOP_MIN_CACHEABLE_BYTES, hotBytes: 70 * MB }))
      .toMatchObject({ start: true, scope: "full" });
  });

  it("warms fully when the working set leaves a third of the budget free", () => {
    expect(plan({ fileBytes: 1_200 * MB, cacheableBytes: 2_000 * MB }))
      .toMatchObject({ start: true, scope: "full" });
    // Measured working set from a previous pass replaces the 0.35 estimate.
    const measured = plan({ fileBytes: 6_300 * MB, hotBytes: 400 * MB, cacheableBytes: 1_400 * MB });
    expect(measured).toMatchObject({ start: true, scope: "full" });
    expect(measured.targetBytes).toBe(400 * MB);
  });

  it("does not read at all on 512 MB and 1 GB machines with a 500k+ index", () => {
    // 512 MB: usable budget below the 128 MB floor once the server RSS is subtracted.
    expect(plan({ fileBytes: 1_200 * MB, cacheableBytes: 100 * MB }))
      .toEqual({ start: false, reason: "low-memory", targetBytes: 0 });
    // 1 GB: W = 420 MB does not fit the 0.7 × 550 MB rule; a metadata pass is not worth it.
    expect(plan({ fileBytes: 1_200 * MB, cacheableBytes: 550 * MB }))
      .toEqual({ start: false, reason: "over-budget", targetBytes: 0 });
  });

  it("never reads on a machine limited to 1 GiB or less, even in `on`", () => {
    // Node 26 reproduction: limit/RSS/file 512/100/160 MB and 1024/150/500 MB.
    // budget = limit − RSS − max(256 MB, 25% of the limit) previously allowed a full pass.
    const budgetMB = (limitMB: number, rssMB: number): number =>
      limitMB - rssMB - Math.max(256, limitMB * 0.25);
    const machines = [
      { limitMB: 512, rssMB: 100, fileMB: 160 },
      { limitMB: 1_024, rssMB: 150, fileMB: 500 },
    ];
    for (const mode of ["auto", "on"] as const) {
      for (const machine of machines) {
        expect(plan({
          mode,
          limitBytes: machine.limitMB * MB,
          fileBytes: machine.fileMB * MB,
          cacheableBytes: budgetMB(machine.limitMB, machine.rssMB) * MB,
        })).toEqual({ start: false, reason: "low-memory", targetBytes: 0 });
      }
    }
  });

  it("warms again one byte above the 1 GiB small-machine limit", () => {
    const limitBytes = WARMUP_SMALL_MACHINE_LIMIT_BYTES + 1;
    const budgetMB = (limitBytes / MB) - 150 - Math.max(256, (limitBytes / MB) * 0.25);
    expect(plan({ limitBytes, fileBytes: 500 * MB, cacheableBytes: budgetMB * MB }))
      .toMatchObject({ start: true, scope: "full" });
    // Desktop keeps its previous behaviour well above the small-machine limit.
    expect(plan({ limitBytes: 16 * 1_024 * MB, desktop: true, fileBytes: 500 * MB, cacheableBytes: 1_000 * MB }))
      .toMatchObject({ start: true, scope: "full" });
  });

  it("falls back to the metadata-only scope above 1 GB of budget", () => {
    const partial = plan({ fileBytes: 6_300 * MB, cacheableBytes: 1_400 * MB });
    expect(partial).toMatchObject({ start: true, scope: "partial", reason: "over-budget" });
    // 0.0075 × 6.3 GB ≈ 47 MB of idx + docsize.
    expect(partial.targetBytes).toBeGreaterThanOrEqual(8 * MB);
    expect(partial.targetBytes).toBeLessThan(60 * MB);
    expect(partial.targetBytes).toBeLessThan(1_400 * MB * 0.7);
  });

  it("respects the operator budget ceiling", () => {
    // The controller passes the ceiling already applied to the budget; a 64 MB budget is
    // below the memory floor, and a partial pass needs at least 1 GB.
    expect(plan({ fileBytes: 1_200 * MB, cacheableBytes: 3_000 * MB }))
      .toMatchObject({ start: true, scope: "full" });
    expect(planWarmup({
      mode: "auto",
      enabled: true,
      desktop: false,
      fileBytes: 1_200 * MB,
      hotBytes: 0,
      limitBytes: 4_096 * MB,
      cacheableBytes: 64 * MB,
    })).toEqual({ start: false, reason: "low-memory", targetBytes: 0 });
    // Exactly at the partial threshold the metadata pass is allowed.
    expect(planWarmup({
      mode: "auto",
      enabled: true,
      desktop: false,
      fileBytes: 6_300 * MB,
      hotBytes: 0,
      limitBytes: 4_096 * MB,
      cacheableBytes: WARMUP_PARTIAL_MIN_CACHEABLE_BYTES,
    })).toMatchObject({ start: true, scope: "partial" });
  });

  it("never targets more than the estimated working set", () => {
    for (const cacheable of [128 * MB, 300 * MB, 1_024 * MB, 4_096 * MB, 16_384 * MB]) {
      for (const fileBytes of [128 * MB, 500 * MB, 1_200 * MB, 6_300 * MB]) {
        const decision = plan({ fileBytes, cacheableBytes: cacheable });
        expect(decision.targetBytes).toBeLessThanOrEqual(fileBytes);
        expect(decision.targetBytes).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps the minimum constants consistent", () => {
    expect(WARMUP_MIN_HOT_BYTES).toBeLessThan(WARMUP_MIN_FILE_BYTES);
    expect(WARMUP_PARTIAL_MIN_CACHEABLE_BYTES).toBeGreaterThan(WARMUP_MIN_CACHEABLE_BYTES);
  });
});
