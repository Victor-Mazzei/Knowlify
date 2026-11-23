import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readSearchCacheMode, readSearchWarmupMaxMb, readSearchWarmupMode } from "../src/config.js";
import {
  cacheLimits,
  MemoryProfile,
  readCgroupMemoryLimit,
  type CgroupLimit,
} from "../src/adapters/runtime/memoryProfile.js";

const MB = 1024 * 1024;
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const files = (v2?: string, v1?: string): { v2: string; v1: string } => {
  const root = mkdtempSync(join(tmpdir(), "knowlify-cgroup-"));
  roots.push(root);
  const paths = { v2: join(root, "memory.max"), v1: join(root, "memory.limit_in_bytes") };
  if (v2 !== undefined) writeFileSync(paths.v2, v2);
  if (v1 !== undefined) writeFileSync(paths.v1, v1);
  return paths;
};

const profile = (options: {
  constrained?: number;
  total?: number;
  free?: number;
  rss?: number;
  cgroup?: CgroupLimit | null;
}): MemoryProfile => new MemoryProfile({
  constrainedMemory: () => options.constrained ?? 0,
  totalMemory: () => options.total ?? 16 * 1024 * MB,
  freeMemory: () => options.free ?? 8 * 1024 * MB,
  rss: () => options.rss ?? 200 * MB,
  cgroupLimit: () => options.cgroup ?? null,
});

describe("readCgroupMemoryLimit", () => {
  it("reads cgroup v2 and treats `max` as unlimited", () => {
    expect(readCgroupMemoryLimit(files("max"))).toEqual({ version: 2, limitBytes: null });
    expect(readCgroupMemoryLimit(files(String(512 * MB)))).toEqual({ version: 2, limitBytes: 512 * MB });
  });

  it("falls back to cgroup v1, including its near-2^63 unlimited sentinel", () => {
    expect(readCgroupMemoryLimit(files(undefined, "9223372036854771712")))
      .toEqual({ version: 1, limitBytes: 9223372036854771712 });
    expect(readCgroupMemoryLimit(files(undefined, String(1024 * MB))))
      .toEqual({ version: 1, limitBytes: 1024 * MB });
  });

  it("returns null when no cgroup file exists (desktop and non-Linux)", () => {
    expect(readCgroupMemoryLimit(files())).toBeNull();
  });
});

describe("MemoryProfile", () => {
  it("uses the smallest of constrained memory, the cgroup limit and physical RAM", () => {
    expect(profile({ constrained: 512 * MB, total: 16 * 1024 * MB }).limitBytes()).toBe(512 * MB);
    expect(profile({ constrained: 0, cgroup: { version: 2, limitBytes: 1024 * MB } }).limitBytes()).toBe(1024 * MB);
    expect(profile({ constrained: 0, total: 2 * 1024 * MB }).limitBytes()).toBe(2 * 1024 * MB);
  });

  it("treats a cgroup v1 sentinel above RAM as no limit", () => {
    const value = profile({ total: 16 * 1024 * MB, cgroup: { version: 1, limitBytes: 9.2e18 } });
    expect(value.limitBytes()).toBe(16 * 1024 * MB);
    expect(value.effectiveCgroupLimitBytes()).toBeNull();
  });

  it("keeps the cacheable budget between zero and the limit in a small container", () => {
    for (const limit of [512 * MB, 1024 * MB, 2 * 1024 * MB]) {
      const value = profile({ cgroup: { version: 2, limitBytes: limit }, rss: 100 * MB });
      const budget = value.cacheableBytes();
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(limit);
      // 512 MB: 512-100-256 = 156 MB; 1 GB: 1024-100-256 = 668 MB.
      expect(budget).toBe(limit - 100 * MB - Math.max(256 * MB, limit * 0.25));
    }
  });

  it("caps a desktop budget at half of free RAM and never goes negative", () => {
    const desktop = profile({ total: 16 * 1024 * MB, free: 2 * 1024 * MB, rss: 300 * MB });
    expect(desktop.effectiveCgroupLimitBytes()).toBeNull();
    expect(desktop.cacheableBytes()).toBe(1024 * MB);
    const tight = profile({ total: 512 * MB, free: 512 * MB, rss: 400 * MB });
    expect(tight.cacheableBytes()).toBe(0);
  });
});

describe("cacheLimits", () => {
  it("sizes entries and bytes by memory tier", () => {
    expect(cacheLimits(512 * MB)).toEqual({ maxEntries: 32, maxBytes: Math.floor(512 * MB * 0.005) });
    expect(cacheLimits(1024 * MB)).toEqual({ maxEntries: 128, maxBytes: Math.floor(1024 * MB * 0.005) });
    expect(cacheLimits(2 * 1024 * MB).maxEntries).toBe(128);
    expect(cacheLimits(4 * 1024 * MB)).toEqual({ maxEntries: 512, maxBytes: 8 * MB });
    expect(cacheLimits(16 * 1024 * MB)).toEqual({ maxEntries: 512, maxBytes: 8 * MB });
  });
});

async function loadConfig(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return (await import("../src/config.js")).config;
}

describe("KNOWLIFY_SEARCH_CACHE", () => {
  it("lands on the boot configuration and fails an invalid value without echoing it", async () => {
    expect((await loadConfig({ KNOWLIFY_SEARCH_CACHE: undefined })).search.cache).toBe("auto");
    expect((await loadConfig({ KNOWLIFY_SEARCH_CACHE: "off" })).search.cache).toBe("off");
    let message = "";
    try {
      await loadConfig({ KNOWLIFY_SEARCH_CACHE: "top-secret-value" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("KNOWLIFY_SEARCH_CACHE must be auto or off");
    expect(message).not.toContain("top-secret-value");
  });

  it("defaults to auto and accepts off case-insensitively", () => {
    expect(readSearchCacheMode(undefined)).toBe("auto");
    expect(readSearchCacheMode("")).toBe("auto");
    expect(readSearchCacheMode(" AUTO ")).toBe("auto");
    expect(readSearchCacheMode("off")).toBe("off");
  });

  it("fails the boot without echoing the invalid value", () => {
    let message = "";
    try {
      readSearchCacheMode("top-secret-value");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("KNOWLIFY_SEARCH_CACHE must be auto or off");
    expect(message).not.toContain("top-secret-value");
  });
});

describe("KNOWLIFY_SEARCH_WARMUP", () => {
  it("defaults to auto, accepts on and off, and rejects an unknown value", () => {
    expect(readSearchWarmupMode(undefined)).toBe("auto");
    expect(readSearchWarmupMode("")).toBe("auto");
    expect(readSearchWarmupMode(" ON ")).toBe("on");
    expect(readSearchWarmupMode("off")).toBe("off");
    expect(() => readSearchWarmupMode("sometimes")).toThrow("KNOWLIFY_SEARCH_WARMUP must be auto, on or off");
  });

  it("parses the optional budget ceiling and treats zero as off", async () => {
    expect(readSearchWarmupMaxMb(undefined)).toBeNull();
    expect(readSearchWarmupMaxMb("")).toBeNull();
    expect(readSearchWarmupMaxMb("0")).toBe(0);
    expect(readSearchWarmupMaxMb("1024")).toBe(1024);
    expect((await loadConfig({ KNOWLIFY_SEARCH_WARMUP: "on", KNOWLIFY_SEARCH_WARMUP_MAX_MB: "512" })).search.warmup)
      .toEqual({ mode: "on", maxMb: 512 });
  });

  it("fails the boot without echoing the invalid value", () => {
    let message = "";
    try {
      readSearchWarmupMaxMb("top-secret-value");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("KNOWLIFY_SEARCH_WARMUP_MAX_MB must be a non-negative integer");
    expect(message).not.toContain("top-secret-value");
    expect(() => readSearchWarmupMaxMb("-1")).toThrow("KNOWLIFY_SEARCH_WARMUP_MAX_MB must be a non-negative integer");
    expect(() => readSearchWarmupMaxMb("1.5")).toThrow("KNOWLIFY_SEARCH_WARMUP_MAX_MB must be a non-negative integer");
  });
});
