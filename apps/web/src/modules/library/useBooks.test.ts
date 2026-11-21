import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../services/api";
import type { Book, BookPage } from "../../types";
import { HYDRATE_THROTTLE_MS, useBooks, type BooksQuery } from "./useBooks";
import { EMPTY_FILTERS } from "./libraryFilters";

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id,
  title: `Book ${id}`,
  author: "An Author",
  format: "pdf",
  size: 10,
  addedAt: 0,
  hasCover: false,
  status: "ready",
  source: false,
  ...overrides,
});

const page = (items: Book[], total: number, nextCursor: string | null = null): BookPage => ({ items, total, nextCursor });
const response = (body: unknown) => new Response(JSON.stringify(body));

const query = (overrides: Partial<BooksQuery> = {}): BooksQuery => ({
  query: "",
  sort: "added",
  order: "desc",
  filters: EMPTY_FILTERS,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function unexpectedApi() {
  return vi.fn(async (_path: string, _init?: RequestInit): Promise<Response> => {
    throw new Error("Unexpected API call");
  });
}

/** Lets a resolved mock response finish its JSON parsing and state updates. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useBooks", () => {
  it("loads the first page with the paged envelope and keeps the server total", async () => {
    const api = vi.fn(async () => response(page([book("b1")], 11_000, "next")));
    const { result } = renderHook(() => useBooks(api, query()));

    await waitFor(() => expect(result.current.books).toHaveLength(1));
    expect(api).toHaveBeenCalledWith(expect.stringContaining("limit=60"), expect.anything());
    expect(api).toHaveBeenCalledWith(expect.stringContaining("sort=added"), expect.anything());
    expect(result.current.total).toBe(11_000);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("sends every active filter and the last-read order", async () => {
    const api = vi.fn(async (_path: string, _init?: RequestInit) => response(page([book("b1")], 1)));
    renderHook(() =>
      useBooks(
        api,
        query({
          filters: { ...EMPTY_FILTERS, format: ["pdf"], read: ["reading", "finished"], index: ["error"], source: ["s1", "upload"], notes: true },
          sort: "lastRead",
          order: "desc",
        }),
      ),
    );

    await waitFor(() => expect(api).toHaveBeenCalled());
    const url = new URL(String(api.mock.calls[0]?.[0]), "http://test");
    expect(url.searchParams.get("format")).toBe("pdf");
    expect(url.searchParams.get("read")).toBe("reading,finished");
    expect(url.searchParams.get("index")).toBe("error");
    expect(url.searchParams.get("source")).toBe("s1,upload");
    expect(url.searchParams.get("notes")).toBe("1");
    expect(url.searchParams.get("sort")).toBe("lastRead");
    expect(url.searchParams.get("order")).toBe("desc");
  });

  it("sends the author sort in ascending order by default", async () => {
    const api = vi.fn(async (_path: string, _init?: RequestInit) => response(page([book("b1")], 1)));
    renderHook(() => useBooks(api, query({ sort: "author", order: "asc" })));

    await waitFor(() => expect(api).toHaveBeenCalled());
    const url = new URL(String(api.mock.calls[0]?.[0]), "http://test");
    expect(url.searchParams.get("sort")).toBe("author");
    expect(url.searchParams.get("order")).toBe("asc");
  });

  it("accepts the legacy array response from an older server", async () => {
    const api = vi.fn(async () => response([book("old-1"), book("old-2")]));
    const { result } = renderHook(() => useBooks(api, query()));

    await waitFor(() => expect(result.current.books).toHaveLength(2));
    expect(result.current.total).toBe(2);
    expect(result.current.hasMore).toBe(false);
  });

  it("windows a legacy array locally instead of mounting every book", async () => {
    const all = Array.from({ length: 130 }, (_, index) => book(`old-${index}`));
    const api = vi.fn(async () => response(all));
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.books).toHaveLength(60));
    expect(result.current.total).toBe(130);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.books).toHaveLength(120);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.books).toHaveLength(130);
    expect(result.current.hasMore).toBe(false);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("sorts a legacy array by reading first when the server ignores the sort", async () => {
    const all = [
      book("finished", { addedAt: 500, progress: { percentage: 0.995, updatedAt: 900 } }),
      book("reading-old", { addedAt: 100, progress: { percentage: 0.4, updatedAt: 100 } }),
      book("unread", { addedAt: 600 }),
      book("reading-new", { addedAt: 200, progress: { percentage: 0.2, updatedAt: 800 } }),
    ];
    const api = vi.fn(async () => response(all));
    const { result } = renderHook(() => useBooks(api, query({ sort: "reading" })));
    await waitFor(() => expect(result.current.books).toHaveLength(4));
    expect(result.current.books.map((entry) => entry.id)).toEqual([
      "reading-new",
      "reading-old",
      "unread",
      "finished",
    ]);
  });

  it("debounces a query change and aborts the superseded request", async () => {
    vi.useFakeTimers();
    const signals: (AbortSignal | undefined)[] = [];
    const api = vi.fn((_path: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return signals.length === 1
        ? Promise.resolve(response(page([book("b1")], 1)))
        : new Promise<Response>(() => undefined);
    });
    const { result, rerender } = renderHook((props: BooksQuery) => useBooks(api, props), { initialProps: query() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api).toHaveBeenCalledTimes(1);

    rerender(query({ query: "dune" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(api).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining("q=dune"), expect.anything());

    rerender(query({ query: "dune messiah" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(api).toHaveBeenCalledTimes(3);
    expect(signals[1]?.aborted).toBe(true);
  });

  it("switches to title order without a debounce", async () => {
    const api = vi.fn(async () => response(page([book("b1")], 1)));
    const { rerender } = renderHook((props: BooksQuery) => useBooks(api, props), { initialProps: query() });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    rerender(query({ sort: "title", order: "asc" }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining("sort=title"), expect.anything());
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining("order=asc"), expect.anything());
  });

  it("cancels the in-flight page and resets rows when filters change", async () => {
    const stale = deferred<Response>();
    const fresh = deferred<Response>();
    const api = unexpectedApi().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const { result, rerender } = renderHook((props: BooksQuery) => useBooks(api, props), { initialProps: query() });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    const staleSignal = api.mock.calls[0]?.[1]?.signal;

    rerender(query({ filters: { ...EMPTY_FILTERS, read: ["reading"] } }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(staleSignal?.aborted).toBe(true);
    expect(result.current.books).toHaveLength(0);
    expect(result.current.loading).toBe(true);
    expect(new URL(String(api.mock.calls[1]?.[0]), "http://test").searchParams.get("read")).toBe("reading");

    await act(async () => {
      stale.resolve(response(page([book("stale")], 1)));
      await tick();
    });
    expect(result.current.books).toHaveLength(0);

    await act(async () => {
      fresh.resolve(response(page([book("r1")], 1)));
      await tick();
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["r1"]);
    expect(result.current.loading).toBe(false);
  });

  it("reloads the first page when the server rejects a cursor", async () => {
    const api = unexpectedApi()
      .mockResolvedValueOnce(response(page([book("b1")], 2, "stale")))
      .mockRejectedValueOnce(new ApiError(400, "cursor is invalid"))
      .mockResolvedValueOnce(response(page([book("fresh")], 1, null)));
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.error).toBe("");
    expect(result.current.books.map((item) => item.id)).toEqual(["fresh"]);
    const retried = String(api.mock.calls[2]?.[0]);
    expect(retried).not.toContain("cursor=");
  });

  it("appends the next page and de-duplicates ids", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(response(page([book("b1")], 3, "cursor-1")))
      .mockResolvedValueOnce(response(page([book("b1"), book("b2")], 3, null)));
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.books).toHaveLength(1));

    await act(async () => {
      await result.current.loadMore();
    });
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining("cursor=cursor-1"), expect.anything());
    expect(result.current.books.map((item) => item.id)).toEqual(["b1", "b2"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("reports an error and retries", async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(page([book("b1")], 1)));
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.error).toBe("offline"));

    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.error).toBe("");
    expect(result.current.books).toHaveLength(1);
  });

  it("hydrates only visible pending or indexing books, at most every five seconds", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string) =>
      path.includes("ids=")
        ? response(page([book("p1", { status: "ready", index: { state: "ready", error: null } })], 1))
        : response(page([book("p1", { status: "pending" }), book("b2")], 2)),
    );
    const { result } = renderHook(() => useBooks(api, query()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.hydrateVisible(["p1", "b2"]);
    });
    expect(api).toHaveBeenLastCalledWith(expect.stringMatching(/\/api\/books\?ids=p1$/), expect.anything());
    expect(result.current.books[0]?.status).toBe("ready");

    await act(async () => {
      await result.current.hydrateVisible(["p1"]);
    });
    const hydrationCalls = api.mock.calls.filter(([path]) => String(path).includes("ids="));
    expect(hydrationCalls).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HYDRATE_THROTTLE_MS);
    });
    await act(async () => {
      await result.current.hydrateVisible(["p1"]);
    });
    // It is ready now, so there is nothing left to hydrate.
    expect(api.mock.calls.filter(([path]) => String(path).includes("ids="))).toHaveLength(1);
  });

  it("does not reload the whole list when the window regains focus", async () => {
    const api = vi.fn(async () => response(page([book("b1")], 1)));
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.books).toHaveLength(1));
    api.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(api).not.toHaveBeenCalled();
  });

  it("keeps the previous rows visible during a silent refresh and then replaces them", async () => {
    const fresh = deferred<Response>();
    const api = unexpectedApi()
      .mockResolvedValueOnce(response(page([book("old")], 2, "old-cursor")))
      .mockReturnValueOnce(fresh.promise);
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.books).toHaveLength(1));

    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.books.map((item) => item.id)).toEqual(["old"]);

    await act(async () => {
      fresh.resolve(response(page([book("new")], 3, "new-cursor")));
      await refreshing;
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["new"]);
    expect(result.current.loading).toBe(false);
  });

  it("drops loaded books that disappeared and restarts pagination from the refreshed first page", async () => {
    const api = unexpectedApi()
      .mockResolvedValueOnce(response(page([book("b1"), book("b2")], 3, "cursor-1")))
      .mockResolvedValueOnce(response(page([book("b3")], 3, null)))
      .mockResolvedValueOnce(response(page([book("b2")], 2, "fresh-cursor")));
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.books).toHaveLength(2));

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["b1", "b2", "b3"]);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["b2"]);
    expect(result.current.total).toBe(2);
    expect(result.current.hasMore).toBe(true);

    api.mockResolvedValueOnce(response(page([book("b3")], 2, null)));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining("cursor=fresh-cursor"), expect.anything());
    expect(result.current.books.map((item) => item.id)).toEqual(["b2", "b3"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("discards a load-more response that arrives after a refresh", async () => {
    const stale = deferred<Response>();
    const api = unexpectedApi()
      .mockResolvedValueOnce(response(page([book("b1")], 4, "old-cursor")))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response(page([book("b2")], 3, "fresh-cursor")));
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.books).toHaveLength(1));

    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(true));
    const staleSignal = api.mock.calls[1]?.[1]?.signal;

    await act(async () => {
      await result.current.refresh();
    });
    expect(staleSignal?.aborted).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.books.map((item) => item.id)).toEqual(["b2"]);

    await act(async () => {
      stale.resolve(response(page([book("b1"), book("late")], 4, null)));
      await tick();
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["b2"]);
    expect(result.current.loadingMore).toBe(false);
  });

  it("does not append against the old cursor while a refresh is in flight", async () => {
    const oldMore = deferred<Response>();
    const fresh = deferred<Response>();
    const api = unexpectedApi()
      .mockResolvedValueOnce(response(page([book("b1")], 4, "old-cursor")))
      .mockReturnValueOnce(oldMore.promise)
      .mockReturnValueOnce(fresh.promise);
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.books).toHaveLength(1));

    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    expect(result.current.loadingMore).toBe(false);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(api).toHaveBeenCalledTimes(3);

    await act(async () => {
      fresh.resolve(response(page([book("b2")], 3, "fresh-cursor")));
      await refreshing;
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["b2"]);

    api.mockResolvedValueOnce(response(page([book("b3")], 3, null)));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining("cursor=fresh-cursor"), expect.anything());
    expect(result.current.books.map((item) => item.id)).toEqual(["b2", "b3"]);

    await act(async () => {
      oldMore.resolve(response(page([book("stale")], 4, null)));
      await tick();
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["b2", "b3"]);
    expect(result.current.loadingMore).toBe(false);
  });

  it("does not let a superseded load-more clear the loading state of the new one", async () => {
    const stale = deferred<Response>();
    const latest = deferred<Response>();
    const api = unexpectedApi()
      .mockResolvedValueOnce(response(page([book("b1")], 5, "old-cursor")))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response(page([book("b2")], 4, "fresh-cursor")))
      .mockReturnValueOnce(latest.promise);
    const { result } = renderHook(() => useBooks(api, query()));
    await waitFor(() => expect(result.current.books).toHaveLength(1));

    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["b2"]);

    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    await act(async () => {
      stale.resolve(response(page([book("stale")], 5, null)));
      await tick();
    });
    expect(result.current.loadingMore).toBe(true);

    await act(async () => {
      latest.resolve(response(page([book("b3")], 4, null)));
      await tick();
    });
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.books.map((item) => item.id)).toEqual(["b2", "b3"]);
  });

  it("clears a pending load-more when the query changes and ignores its late response", async () => {
    vi.useFakeTimers();
    const stale = deferred<Response>();
    const api = unexpectedApi()
      .mockResolvedValueOnce(response(page([book("b1")], 4, "old-cursor")))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response(page([book("s1")], 1, null)));
    const { result, rerender } = renderHook((props: BooksQuery) => useBooks(api, props), { initialProps: query() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.books).toHaveLength(1);

    act(() => {
      void result.current.loadMore();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loadingMore).toBe(true);
    const staleSignal = api.mock.calls[1]?.[1]?.signal;

    rerender(query({ query: "dune" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(api).toHaveBeenCalledTimes(3);
    expect(staleSignal?.aborted).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.books.map((item) => item.id)).toEqual(["s1"]);

    await act(async () => {
      stale.resolve(response(page([book("late")], 4, null)));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.books.map((item) => item.id)).toEqual(["s1"]);
    expect(result.current.loadingMore).toBe(false);
  });
});
