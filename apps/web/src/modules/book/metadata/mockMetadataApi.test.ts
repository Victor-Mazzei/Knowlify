import { describe, expect, it } from "vitest";
import { getMetadataStatus, resetBookMetadata, searchBookMetadata, setBookCoverFromUrl, updateBookMetadata, uploadBookCover } from "../metadataApi";
import { sampleBookDetail } from "./mockMetadataBook";
import { createMockMetadataApi } from "./mockMetadataApi";
import {
  MOCK_METADATA_SCENARIOS,
  mockMetadataScenario,
  type MockMetadataScenario,
} from "./mockMetadataScenarios";

const book = sampleBookDetail();

describe("mockMetadataApi", () => {
  it("serves a coherent detail and preserves the file values across overrides", async () => {
    const api = createMockMetadataApi();
    const detail = await updateBookMetadata(api, book.id, {
      title: "Edited title",
      author: "Edited author",
      isbn13: "978-0-306-40615-7",
      year: 2005,
      source: "manual",
    });
    expect(detail.title).toBe("Edited title");
    expect(detail.metadata.title).toBe("Edited title");
    expect(detail.metadata.file).toEqual({ title: "The Quiet Library", author: "Ada North" });
    expect(detail.metadata.overridden.title).toBe(true);
    expect(detail.metadata.overridden.author).toBe(true);
    expect(detail.metadata.isbn13).toBe("9780306406157");
    expect(detail.metadata.source).toBe("manual");

    const cleared = await updateBookMetadata(api, book.id, { title: null });
    expect(cleared.title).toBe("The Quiet Library");
    expect(cleared.metadata.overridden.title).toBe(false);
  });

  it("validates patch fields with 400 codes", async () => {
    const api = createMockMetadataApi();
    const unknown = await api(`/api/books/${book.id}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({ nope: "x" }),
    });
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({ field: "nope" });

    const invalid = await api(`/api/books/${book.id}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({ isbn13: "9780306406158" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ field: "isbn13" });

    const empty = await api(`/api/books/${book.id}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({ publisher: "" }),
    });
    expect(empty.status).toBe(400);
  });

  it("resets everything, including the custom cover", async () => {
    const api = createMockMetadataApi();
    await updateBookMetadata(api, book.id, { title: "Edited" });
    const covered = await setBookCoverFromUrl(api, book.id, "https://covers.openlibrary.org/b/id/1-L.jpg");
    expect(covered.metadata.overridden.cover).toBe(true);
    expect(covered.coverRev).toBe(1);
    const reset = await resetBookMetadata(api, book.id);
    expect(reset.title).toBe("The Quiet Library");
    expect(reset.metadata.overridden.cover).toBe(false);
    expect(reset.coverRev).toBeNull();
    expect(reset.metadata.source).toBeNull();
  });

  it("accepts an upload and rejects a bad cover URL or type", async () => {
    const api = createMockMetadataApi();
    const file = new File([new Uint8Array([1])], "cover.png", { type: "image/png" });
    const loaded = await uploadBookCover(api, book.id, file);
    expect(loaded.metadata.overridden.cover).toBe(true);

    const foreign = await api(`/api/books/${book.id}/cover/from-url`, {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/cover.jpg" }),
    });
    expect(foreign.status).toBe(400);

    const text = new File(["not an image"], "notes.txt", { type: "text/plain" });
    const rejected = await api(`/api/books/${book.id}/cover`, { method: "PUT", body: (() => {
      const body = new FormData();
      body.set("file", text);
      return body;
    })() });
    expect(rejected.status).toBe(415);
  });

  it("searches by ISBN and title, returning provider errors and rate limits", async () => {
    const api = createMockMetadataApi();
    await expect(getMetadataStatus(api)).resolves.toMatchObject({ enabled: true });
    const byIsbn = await searchBookMetadata(api, { isbn: "9780306406157" });
    expect(byIsbn.candidates).toHaveLength(1);
    expect(byIsbn.candidates[0]).toMatchObject({ source: "googlebooks", title: "The Quiet Library" });

    const byTitle = await searchBookMetadata(api, { title: "Quiet Library" });
    expect(byTitle.candidates.length).toBeGreaterThan(1);

    const limited = createMockMetadataApi({ rateLimitAfter: 0 });
    await expect(searchBookMetadata(limited, { isbn: "9780306406157" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });

    const partial = createMockMetadataApi({
      candidates: [],
      searchErrors: [{ source: "openlibrary", code: "timeout" }],
    });
    await expect(searchBookMetadata(partial, { title: "Nothing" })).resolves.toEqual({
      candidates: [],
      errors: [{ source: "openlibrary", code: "timeout" }],
    });
  });

  it("serves ready-made search scenarios, including another provider's candidates", async () => {
    const scenarios: Array<[MockMetadataScenario, string | null, boolean]> = [
      ["service-disabled", "service_disabled", false],
      ["key-rejected", "key_rejected", false],
      ["network", "network", false],
      ["timeout", "timeout", false],
      ["upstream-error", "upstream_error", false],
      ["not-found", "not_found", false],
      ["empty", null, false],
      ["rate-limited", "rate_limited", true],
    ];
    for (const [name, reason, hasCandidates] of scenarios) {
      const result = await searchBookMetadata(createMockMetadataApi({ scenario: name }), {
        title: "Quiet Library",
      });
      expect(result.errors.map((error) => error.reason ?? null)).toEqual(reason ? [reason] : []);
      expect(result.candidates.length > 0).toBe(hasCandidates);
      if (hasCandidates) expect(result.candidates.every((candidate) => candidate.source === "openlibrary")).toBe(true);
    }
  });

  it("accepts the scenario from ?mock=metadata-search&scenario=… in dev", async () => {
    const original = window.location.href;
    window.history.replaceState({}, "", "/?mock=metadata-search&scenario=network");
    try {
      const result = await searchBookMetadata(createMockMetadataApi(), { title: "Quiet Library" });
      expect(result.errors).toEqual([{ source: "googlebooks", code: "unavailable", reason: "network" }]);
    } finally {
      window.history.replaceState({}, "", original);
    }
  });

  it("maps only known scenario names", () => {
    for (const scenario of MOCK_METADATA_SCENARIOS) {
      expect(mockMetadataScenario(scenario)).toBe(scenario);
    }
    expect(mockMetadataScenario("future-scenario")).toBeNull();
    expect(mockMetadataScenario(null)).toBeNull();
  });

  it("simulates disabled and unsupported lookup servers", async () => {
    const off = createMockMetadataApi({ lookup: "off" });
    await expect(getMetadataStatus(off)).resolves.toMatchObject({ enabled: false });
    await expect(searchBookMetadata(off, { isbn: "9780306406157" })).rejects.toMatchObject({
      status: 403,
      code: "lookup_disabled",
    });
    const disabledCover = await off(`/api/books/${book.id}/cover/from-url`, {
      method: "POST",
      body: JSON.stringify({ url: "https://covers.openlibrary.org/b/id/1-L.jpg" }),
    });
    expect(disabledCover.status).toBe(403);

    const old = createMockMetadataApi({ lookup: "unsupported" });
    await expect(getMetadataStatus(old)).rejects.toMatchObject({ status: 404 });
    await expect(searchBookMetadata(old, { title: "Quiet" })).rejects.toMatchObject({ status: 404 });
  });

  it("matches the server on source-only patches, series clearing, NFC and control characters", async () => {
    const api = createMockMetadataApi();
    const patch = (body: unknown) =>
      api(`/api/books/${book.id}/metadata`, { method: "PATCH", body: JSON.stringify(body) });

    expect((await patch({ source: "manual" })).status).toBe(400);
    expect((await patch({ title: "Bad\u0007title" })).status).toBe(400);

    const composed = await updateBookMetadata(api, book.id, { title: "Cafe\u0301" });
    expect(composed.metadata.title).toBe("Caf\u00e9");

    await updateBookMetadata(api, book.id, { series: "Archive", seriesIndex: 2 });
    const cleared = await updateBookMetadata(api, book.id, { series: null });
    expect(cleared.metadata.series).toBeNull();
    expect(cleared.metadata.seriesIndex).toBeNull();
  });
});
