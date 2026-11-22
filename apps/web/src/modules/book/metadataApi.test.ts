import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../services/api";
import {
  MetadataUnsupportedError,
  getMetadataStatus,
  isMetadataLookupDisabled,
  isMetadataLookupUnsupported,
  loadBookDetail,
  metadataErrorField,
  resetBookCover,
  resetBookMetadata,
  searchBookMetadata,
  setBookCoverFromUrl,
  updateBookMetadata,
  uploadBookCover,
} from "./metadataApi";
import { sampleBookDetail } from "./metadata/mockMetadataBook";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("metadataApi", () => {
  it("loads the detail and rejects a server without metadata", async () => {
    const detail = sampleBookDetail();
    const api = vi.fn(async () => json(detail));
    await expect(loadBookDetail(api, "book/1")).resolves.toMatchObject({ id: "meta-1" });
    expect(api).toHaveBeenCalledWith("/api/books/book%2F1", {});

    const legacy = vi.fn(async () => json({ id: "meta-1", title: "Old" }));
    await expect(loadBookDetail(legacy, "meta-1")).rejects.toBeInstanceOf(MetadataUnsupportedError);
  });

  it("patches partially and returns the updated detail", async () => {
    const detail = sampleBookDetail();
    const api = vi.fn(async () => json(detail));
    await updateBookMetadata(api, "meta-1", { title: "New", source: "manual" });
    expect(api).toHaveBeenCalledWith("/api/books/meta-1/metadata", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New", source: "manual" }),
    });
  });

  it("resets metadata and covers with DELETE", async () => {
    const api = vi.fn(async () => json(sampleBookDetail()));
    await resetBookMetadata(api, "a");
    await resetBookCover(api, "a");
    expect(api.mock.calls).toEqual([
      ["/api/books/a/metadata", { method: "DELETE" }],
      ["/api/books/a/cover", { method: "DELETE" }],
    ]);
  });

  it("uploads the cover as multipart without setting the content type", async () => {
    const api = vi.fn(async () => json(sampleBookDetail()));
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    await uploadBookCover(api, "meta-1", file);
    const calls = api.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const init = calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
  });

  it("sends an allowlisted cover URL as JSON", async () => {
    const api = vi.fn(async () => json(sampleBookDetail()));
    await setBookCoverFromUrl(api, "meta-1", "https://covers.openlibrary.org/b/id/1-L.jpg");
    expect(api).toHaveBeenCalledWith("/api/books/meta-1/cover/from-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://covers.openlibrary.org/b/id/1-L.jpg" }),
    });
  });

  it("reads lookup status and recognizes a server without the route", async () => {
    const status = {
      enabled: true,
      providers: [
        { id: "googlebooks", keyConfigured: false },
        { id: "openlibrary", keyConfigured: false },
      ],
    };
    const api = vi.fn(async () => json(status));
    await expect(getMetadataStatus(api)).resolves.toEqual(status);

    const old = vi.fn(async () => json({ message: "Not found" }, 404));
    await expect(getMetadataStatus(old)).rejects.toMatchObject({ status: 404 });
    expect(isMetadataLookupUnsupported(new ApiError(404, "Not found"))).toBe(true);
    expect(isMetadataLookupDisabled(new ApiError(403, "Off", "lookup_disabled"))).toBe(true);
  });

  it("builds one search mode at a time and surfaces provider failures", async () => {
    const api = vi.fn(async () =>
      json({
        candidates: [],
        errors: [{ source: "googlebooks", code: "rate_limited" }],
      }),
    );
    await searchBookMetadata(api, { title: "Quiet Library", author: "Ada North" });
    expect(api).toHaveBeenLastCalledWith("/api/metadata/search?title=Quiet+Library&author=Ada+North");

    await searchBookMetadata(api, { isbn: "9780306406157" });
    expect(api).toHaveBeenLastCalledWith("/api/metadata/search?isbn=9780306406157");
    await expect(searchBookMetadata(api, { isbn: "9780306406157" })).resolves.toEqual({
      candidates: [],
      errors: [{ source: "googlebooks", code: "rate_limited" }],
    });
  });

  it("keeps known reasons and drops unknown or absent ones without rejecting the response", async () => {
    const api = vi.fn(async () =>
      json({
        candidates: [],
        errors: [
          { source: "googlebooks", code: "unavailable", reason: "service_disabled" },
          { source: "googlebooks", code: "unavailable", reason: "future_reason" },
          { source: "openlibrary", code: "timeout", reason: 7 },
          { source: "openlibrary", code: "rate_limited", reason: null },
          { source: "googlebooks", code: "unavailable" },
        ],
      }),
    );
    await expect(searchBookMetadata(api, { isbn: "9780306406157" })).resolves.toEqual({
      candidates: [],
      errors: [
        { source: "googlebooks", code: "unavailable", reason: "service_disabled" },
        { source: "googlebooks", code: "unavailable" },
        { source: "openlibrary", code: "timeout" },
        { source: "openlibrary", code: "rate_limited" },
        { source: "googlebooks", code: "unavailable" },
      ],
    });
  });

  it("keeps field errors from a 400 and rejects malformed candidates", async () => {
    const bad = vi.fn(async () => json({ message: "ISBN invalid", field: "isbn13" }, 400));
    const failure = await searchBookMetadata(bad, { isbn: "9780306406157" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(metadataErrorField(failure)).toBe("isbn13");
    expect(metadataErrorField(new ApiError(400, "x", undefined, { field: "seriesIndex" }))).toBe("seriesIndex");

    const malformed = vi.fn(async () => json({ candidates: [{ title: "No source" }], errors: [] }));
    await expect(searchBookMetadata(malformed, { isbn: "9780306406157" })).rejects.toThrow(
      "unexpected metadata search",
    );

    const badError = vi.fn(async () => json({ candidates: [], errors: [{ source: "elsewhere", code: "unavailable" }] }));
    await expect(searchBookMetadata(badError, { isbn: "9780306406157" })).rejects.toThrow(
      "unexpected metadata search",
    );
  });
});
