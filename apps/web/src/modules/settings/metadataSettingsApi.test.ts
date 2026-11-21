import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { validateMetadataKey } from "./metadataForm";
import { createMockMetadataApi, initialMetadataView } from "./metadataSettingsMock";
import { createMetadataSettingsApi } from "./metadataSettingsApi";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("metadataSettingsApi", () => {
  it("reads and writes the documented route and body", async () => {
    const api = vi.fn<ApiFn>(async () => json(initialMetadataView("saved")));
    const client = createMetadataSettingsApi(api);

    const view = await client.get();
    expect(view.googleBooks.source).toBe("user");
    expect(api).toHaveBeenCalledWith("/api/settings/metadata", {});

    await client.save({ lookupEnabled: false, googleBooksKey: "key-1" });
    const [path, init] = api.mock.calls[api.mock.calls.length - 1] ?? [];
    expect(path).toBe("/api/settings/metadata");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ lookupEnabled: false, googleBooksKey: "key-1" });
  });

  it("surfaces 404 and rejects an unexpected payload", async () => {
    const missing: ApiFn = async () => new Response("{}", { status: 404 });
    await expect(createMetadataSettingsApi(missing).get()).rejects.toMatchObject({ status: 404 });

    const malformed: ApiFn = async () => json({ lookupEnabled: true });
    await expect(createMetadataSettingsApi(malformed).get()).rejects.toThrow(
      "The server sent an unexpected response.",
    );
  });

  it("never returns a key from the mock", async () => {
    const client = createMetadataSettingsApi(createMockMetadataApi({ scenario: "saved" }));
    const view = await client.get();
    expect(view.googleBooks).toEqual({ hasKey: true, keyState: "ok", source: "user" });
    expect(JSON.stringify(view)).not.toContain("key-1");
  });

  it("round-trips key overrides and removals in the mock", async () => {
    const client = createMetadataSettingsApi(createMockMetadataApi({ scenario: "env-key" }));
    expect((await client.get()).googleBooks.source).toBe("env");

    const saved = await client.save({ googleBooksKey: "user-key" });
    expect(saved.googleBooks).toEqual({ hasKey: true, keyState: "ok", source: "user" });
    const removed = await client.save({ googleBooksKey: null });
    expect(removed.googleBooks).toEqual({ hasKey: true, keyState: "ok", source: "env" });
  });

  it("rejects invalid keys with a 400", async () => {
    const api = createMockMetadataApi();
    await expect(
      api("/api/settings/metadata", {
        method: "PUT",
        body: JSON.stringify({ googleBooksKey: "has space" }),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("validateMetadataKey", () => {
  it("accepts visible ASCII and rejects spaces, controls and overlong values", () => {
    expect(validateMetadataKey("AIzaSy-123_abc")).toBe("");
    expect(validateMetadataKey("has space")).toMatch(/printable ASCII/);
    expect(validateMetadataKey("line\nbreak")).toMatch(/printable ASCII/);
    expect(validateMetadataKey("x".repeat(257))).toMatch(/256 characters/);
    expect(validateMetadataKey("")).toMatch(/Enter a key/);
  });
});

describe("mock metadata errors", () => {
  it("uses ApiError for locked and unavailable states", async () => {
    const locked = createMockMetadataApi({ scenario: "locked" });
    await expect(
      locked("/api/settings/metadata", { method: "PUT", body: JSON.stringify({ lookupEnabled: false }) }),
    ).rejects.toBeInstanceOf(ApiError);

    const unavailable = createMockMetadataApi({ scenario: "unavailable" });
    await expect(unavailable("/api/settings/metadata")).rejects.toMatchObject({ status: 404 });
  });
});
