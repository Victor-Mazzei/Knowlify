import { afterEach, describe, expect, it, vi } from "vitest";
import { readNetworkGuardMode } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("KNOWLIFY_NETWORK_GUARD", () => {
  it("defaults to off and accepts lan", () => {
    expect(readNetworkGuardMode(undefined)).toBe("off");
    expect(readNetworkGuardMode("")).toBe("off");
    expect(readNetworkGuardMode(" off ")).toBe("off");
    expect(readNetworkGuardMode("OFF")).toBe("off");
    expect(readNetworkGuardMode("lan")).toBe("lan");
    expect(readNetworkGuardMode(" LAN ")).toBe("lan");
  });

  it("fails the config load on an invalid value without echoing it", async () => {
    const secret = "SENTINEL-GUARD-VALUE-9f3a";
    vi.stubEnv("KNOWLIFY_NETWORK_GUARD", secret);
    vi.resetModules();
    let message = "";
    try {
      await import("../src/config.js");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("KNOWLIFY_NETWORK_GUARD must be off or lan");
    expect(message).not.toContain(secret);
  });
});
