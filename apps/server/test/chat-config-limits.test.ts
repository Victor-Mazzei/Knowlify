import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

async function loadConfig(value: string | undefined) {
  vi.stubEnv("KNOWLIFY_CHAT_MAX_CONVERSATIONS", value);
  vi.resetModules();
  return (await import("../src/config.js")).config;
}

describe("KNOWLIFY_CHAT_MAX_CONVERSATIONS", () => {
  it("defaults to null (the built-in 200) when unset or empty", async () => {
    expect((await loadConfig(undefined)).chat.maxConversations).toBeNull();
    expect((await loadConfig("  ")).chat.maxConversations).toBeNull();
  });

  it("accepts the documented range", async () => {
    expect((await loadConfig("20")).chat.maxConversations).toBe(20);
    expect((await loadConfig("200")).chat.maxConversations).toBe(200);
    expect((await loadConfig("5000")).chat.maxConversations).toBe(5000);
  });

  it("fails the boot with the range and never echoes the invalid value", async () => {
    for (const value of ["abc", "19", "5001", "20.5", "-20", "200abc"]) {
      vi.stubEnv("KNOWLIFY_CHAT_MAX_CONVERSATIONS", value);
      vi.resetModules();
      let failure: unknown;
      try {
        await import("../src/config.js");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("20");
      expect(message).toContain("5000");
      expect(message).not.toContain(value);
    }
  });

  it("documents the variable in .env.example", () => {
    const env = readFileSync(join(process.cwd(), "..", "..", ".env.example"), "utf8");
    expect(env).toContain("KNOWLIFY_CHAT_MAX_CONVERSATIONS");
    expect(env).toContain("20-5000");
  });
});
