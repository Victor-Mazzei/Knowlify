import { describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { createAboutApi } from "./aboutApi";
import { createMockAboutApi } from "./aboutMock";

describe("aboutApi", () => {
  it("returns the validated about payload", async () => {
    await expect(createAboutApi(createMockAboutApi()).get()).resolves.toEqual({
      version: "1.2.3",
      commit: "a3e1c7f",
      builtAt: "2026-11-07T12:00:00Z",
      node: "22.11.0",
      sourceUrl: "https://github.com/knowlify/knowlify",
    });
  });

  it("keeps the status of a failed request", async () => {
    const api: ApiFn = async () => new Response("{}", { status: 404 });
    await expect(createAboutApi(api).get()).rejects.toMatchObject({ status: 404 });
  });

  it("rejects an unexpected payload", async () => {
    const api: ApiFn = async () => new Response(JSON.stringify({ version: 1 }), { status: 200 });
    await expect(createAboutApi(api).get()).rejects.toThrow("unexpected response");
  });

  it("tolerates a missing source URL and rejects a non-string one", async () => {
    const legacy: ApiFn = async () =>
      new Response(
        JSON.stringify({ version: "1.2.3", commit: null, builtAt: null, node: "22.11.0" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    await expect(createAboutApi(legacy).get()).resolves.toEqual({
      version: "1.2.3",
      commit: null,
      builtAt: null,
      node: "22.11.0",
    });

    const invalid: ApiFn = async () =>
      new Response(JSON.stringify({ version: "1.2.3", commit: null, builtAt: null, node: "22", sourceUrl: 3 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await expect(createAboutApi(invalid).get()).rejects.toThrow("unexpected response");
  });
});
