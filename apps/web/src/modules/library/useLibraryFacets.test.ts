import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../services/api";
import type { BookFacets, Source } from "../../types";
import { EMPTY_FILTERS, type LibraryFilters } from "./libraryFilters";
import { FACETS_DEBOUNCE_MS, FACETS_REFRESH_THROTTLE_MS, useLibraryFacets } from "./useLibraryFacets";

const facets = (index: BookFacets["index"] = { ready: 8, pending: 1, error: 1 }): BookFacets => ({  total: 10,
  format: { pdf: 4, epub: 6 },
  read: { unread: 5, reading: 3, finished: 2 },
  index,
  source: [
    { id: "s1", count: 7 },
    { id: "upload", count: 3 },
  ],
  notes: { with: 2 },
});

const sources: Source[] = [{ id: "s1", path: "/library/Fiction", accessible: true, books: 7 }];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const filters = (overrides: Partial<LibraryFilters> = {}): LibraryFilters => ({ ...EMPTY_FILTERS, ...overrides });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const facetsCallCount = (api: { mock: { calls: unknown[][] } }) =>
  api.mock.calls.filter(([path]) => String(path).startsWith("/api/books/facets")).length;
const sourcesCallCount = (api: { mock: { calls: unknown[][] } }) =>
  api.mock.calls.filter(([path]) => String(path) === "/api/sources").length;

describe("useLibraryFacets", () => {
  it("probes the facets endpoint and loads source labels", async () => {
    const api = vi.fn(async (path: string) => (path.startsWith("/api/books/facets") ? json(facets()) : json(sources)));
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));

    expect(result.current.availability).toBe("unknown");
    await waitFor(() => expect(result.current.availability).toBe("available"));
    expect(result.current.facets?.total).toBe(10);
    await waitFor(() => expect(result.current.sources).toEqual(sources));
  });

  it("sends the current filters to the facets endpoint", async () => {
    const api = vi.fn(async (path: string) => (path.startsWith("/api/books/facets") ? json(facets()) : json([])));
    renderHook(() =>
      useLibraryFacets(api, {
        query: "dune",
        filters: filters({ format: ["pdf"], read: ["reading"], source: ["s1"], notes: true }),
      }),
    );

    await waitFor(() => expect(api).toHaveBeenCalled());
    const url = new URL(String(api.mock.calls[0]?.[0]), "http://test");
    expect(url.pathname).toBe("/api/books/facets");
    expect(url.searchParams.get("q")).toBe("dune");
    expect(url.searchParams.get("format")).toBe("pdf");
    expect(url.searchParams.get("read")).toBe("reading");
    expect(url.searchParams.get("source")).toBe("s1");
    expect(url.searchParams.get("notes")).toBe("1");
  });

  it("hides filters when the server answers 404", async () => {
    const api = vi.fn(async () => json({ message: "Not found" }, 404));
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));

    await waitFor(() => expect(result.current.availability).toBe("unavailable"));
    expect(result.current.facets).toBeNull();
    expect(result.current.error).toBe("");
  });

  it("treats a legacy array as an unavailable server", async () => {
    const api = vi.fn(async () => json([]));
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));

    await waitFor(() => expect(result.current.availability).toBe("unavailable"));
  });

  it("treats the ApiError thrown by useApi as unavailable too", async () => {
    const api = vi.fn(async () => {
      throw new ApiError(404, "Not found");
    });
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));

    await waitFor(() => expect(result.current.availability).toBe("unavailable"));
  });

  it("omits the index filter until the server confirms indexing is enabled", async () => {
    const api = vi.fn(async (path: string) => (path.startsWith("/api/books/facets") ? json(facets()) : json([])));
    const { result } = renderHook(() =>
      useLibraryFacets(api, { query: "", filters: filters({ index: ["error"] }) }),
    );

    await waitFor(() => expect(result.current.availability).toBe("available"), { timeout: 2000 });
    await waitFor(
      () => {
        const calls = api.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith("/api/books/facets"));
        expect(calls).toHaveLength(2);
      },
      { timeout: 2000 },
    );
    const calls = api.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith("/api/books/facets"));
    expect(new URL(calls[0]!, "http://test").searchParams.has("index")).toBe(false);
    expect(new URL(calls[1]!, "http://test").searchParams.get("index")).toBe("error");
  });

  it("never sends index when the server reports indexing disabled", async () => {
    const api = vi.fn(async (path: string) => (path.startsWith("/api/books/facets") ? json(facets(null)) : json([])));
    const { result } = renderHook(() =>
      useLibraryFacets(api, { query: "", filters: filters({ index: ["error"] }) }),
    );

    await waitFor(() => expect(result.current.availability).toBe("available"), { timeout: 1000 });
    expect(result.current.facets?.index).toBeNull();
    const calls = api.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith("/api/books/facets"));
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!, "http://test").searchParams.has("index")).toBe(false);
  });

  it("keeps filters hidden and reports other failures", async () => {
    const api = vi.fn(async () => json({ message: "Server exploded" }, 500));
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));

    await waitFor(() => expect(result.current.error).toBe("Server exploded"));
    expect(result.current.availability).toBe("unknown");
  });

  it("re-reads the counts when the library changes", async () => {
    let total = 10;
    const api = vi.fn(async (path: string) => (path.startsWith("/api/books/facets") ? json({ ...facets(), total }) : json([])));
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));

    await waitFor(() => expect(result.current.facets?.total).toBe(10));
    total = 11;
    act(() => result.current.invalidate());

    await waitFor(() => expect(result.current.facets?.total).toBe(11));
    expect(facetsCallCount(api)).toBe(2);
  });

  it("coalesces a burst of changes into one immediate and one trailing refresh", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string) => (path.startsWith("/api/books/facets") ? json(facets()) : json([])));
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FACETS_DEBOUNCE_MS);
    });
    expect(facetsCallCount(api)).toBe(1);

    act(() => {
      result.current.invalidate();
      result.current.invalidate();
      result.current.invalidate();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FACETS_DEBOUNCE_MS);
    });
    expect(facetsCallCount(api)).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FACETS_REFRESH_THROTTLE_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FACETS_DEBOUNCE_MS);
    });
    expect(facetsCallCount(api)).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FACETS_REFRESH_THROTTLE_MS * 2);
    });
    expect(facetsCallCount(api)).toBe(3);
  });

  it("refreshes folder labels only when the library changes", async () => {
    let path = "/library/Fiction";
    const api = vi.fn(async (request: string) =>
      request.startsWith("/api/books/facets")
        ? json(facets())
        : json([{ id: "s1", path, accessible: true, books: 1 }]),
    );
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));
    await waitFor(() => expect(result.current.sources[0]?.path).toBe("/library/Fiction"));
    expect(sourcesCallCount(api)).toBe(1);

    act(() => result.current.invalidate());
    await waitFor(() => expect(facetsCallCount(api)).toBe(2));
    expect(sourcesCallCount(api)).toBe(1);

    path = "/library/Reference";
    act(() => result.current.invalidateSources());
    await waitFor(() => expect(result.current.sources[0]?.path).toBe("/library/Reference"));
    expect(sourcesCallCount(api)).toBe(2);
  });

  it("ignores a slow response that was already superseded", async () => {
    let resolveOld: (response: Response) => void = () => undefined;
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    let calls = 0;
    const api = vi.fn((path: string) => {
      if (path.startsWith("/api/books/facets")) {
        calls += 1;
        return calls === 1 ? old : Promise.resolve(json({ ...facets(), total: 11 }));
      }
      return Promise.resolve(json([]));
    });
    const { result } = renderHook(() => useLibraryFacets(api, { query: "", filters: EMPTY_FILTERS }));

    await waitFor(() => expect(calls).toBe(1));
    act(() => result.current.invalidate());
    await waitFor(() => expect(result.current.facets?.total).toBe(11));

    await act(async () => {
      resolveOld(json({ ...facets(), total: 99 }));
      await old;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(result.current.facets?.total).toBe(11);
  });
});
