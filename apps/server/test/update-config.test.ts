import { afterEach, describe, expect, it, vi } from "vitest";
import { readUpdateCheckMode } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("KNOWLIFY_UPDATE_CHECK", () => {
  it("defaults to unset (the built-in default is on) and accepts on/off", () => {
    expect(readUpdateCheckMode(undefined)).toBeNull();
    expect(readUpdateCheckMode("")).toBeNull();
    expect(readUpdateCheckMode("  ")).toBeNull();
    expect(readUpdateCheckMode("on")).toBe(true);
    expect(readUpdateCheckMode(" ON ")).toBe(true);
    expect(readUpdateCheckMode("off")).toBe(false);
    expect(readUpdateCheckMode("Off")).toBe(false);
  });

  it("fails the config load on an invalid value without echoing it", async () => {
    const secret = "SENTINEL-UPDATE-VALUE-91bc";
    vi.stubEnv("KNOWLIFY_UPDATE_CHECK", secret);
    vi.resetModules();
    let message = "";
    try {
      await import("../src/config.js");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("KNOWLIFY_UPDATE_CHECK must be on or off");
    expect(message).not.toContain(secret);
  });

  it("keeps the default distinguishable from an explicit env seed", async () => {
    vi.stubEnv("KNOWLIFY_UPDATE_CHECK", undefined);
    vi.stubEnv("KNOWLIFY_UPDATE_LOCKED", undefined);
    vi.resetModules();
    const unset = (await import("../src/config.js")).config;
    expect(unset.update).toEqual({ enabled: null, locked: false });

    vi.stubEnv("KNOWLIFY_UPDATE_CHECK", "off");
    vi.stubEnv("KNOWLIFY_UPDATE_LOCKED", "1");
    vi.resetModules();
    const configured = (await import("../src/config.js")).config;
    expect(configured.update).toEqual({ enabled: false, locked: true });
  });
});
