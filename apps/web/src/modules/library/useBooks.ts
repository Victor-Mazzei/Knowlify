import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { useAutoDismiss } from "../../components/useAutoDismiss";
import { ApiError, formatError, parseApiError } from "../../services/api";
import type { Book, BookOrder, BookSort } from "../../types";
import {
  LEGACY_CURSOR,
  booksPath,
  idsPath,
  isBookPage,
  legacyWindow,
  mergeById,
  needsHydration,
  sortLegacy,
  type ListQuery,
} from "./bookList";
import { filtersKey as filtersKeyOf, type LibraryFilters } from "./libraryFilters";

const SEARCH_DEBOUNCE_MS = 250;
/** Visible rows are re-read at most this often while a book is still importing/indexing. */
export const HYDRATE_THROTTLE_MS = 5000;
const HYDRATE_MAX_IDS = 100;

type LoadMode = "replace" | "refresh";

export type BooksQuery = {
  query: string;
  sort: BookSort;
  order: BookOrder;
  filters: LibraryFilters;
};

async function readPayload(response: Response): Promise<unknown> {
  if (response.ok) return response.json();
  throw await parseApiError(response);
}

/**
 * Paged book list. The caller owns query, sort and filters (URL state); the hook
 * only debounces the search term and swaps the whole list on every other change.
 */
export function useBooks(api: ApiFn, params: BooksQuery) {
  const [books, setBooks] = useState<Book[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState(params.query);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const booksRef = useRef(books);
  booksRef.current = books;
  const cursorRef = useRef(nextCursor);
  cursorRef.current = nextCursor;
  const loadingMoreRef = useRef(false);
  const request = useRef(0);
  const moreRequest = useRef(0);
  const firstPage = useRef<AbortController | null>(null);
  const morePage = useRef<AbortController | null>(null);
  const hydratePage = useRef<AbortController | null>(null);
  const lastHydrate = useRef(0);
  const legacy = useRef<Book[] | null>(null);
  const appliedQuery = useRef(debouncedQuery);
  appliedQuery.current = debouncedQuery;
  const requestParams = useRef({ sort: params.sort, order: params.order, filters: params.filters });
  requestParams.current = { sort: params.sort, order: params.order, filters: params.filters };
  const filtersKey = filtersKeyOf(params.filters);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(params.query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [params.query]);

  const currentQuery = useCallback(
    (): ListQuery => ({
      query: appliedQuery.current,
      sort: requestParams.current.sort,
      order: requestParams.current.order,
      filters: requestParams.current.filters,
    }),
    [],
  );

  const loadFirstPage = useCallback(
    async (mode: LoadMode) => {
      const selected = ++request.current;
      firstPage.current?.abort();
      // A new generation supersedes any page load: stop it and clear its state so a
      // late rejection/resolution cannot leave the new list stuck as "loading more".
      moreRequest.current += 1;
      morePage.current?.abort();
      morePage.current = null;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      hydratePage.current?.abort();
      const controller = new AbortController();
      firstPage.current = controller;
      const query = currentQuery();
      if (mode === "replace") {
        setBooks([]);
        setTotal(0);
        setNextCursor(null);
        setLoading(true);
      }
      setError("");
      try {
        const response = await api(booksPath(query), { signal: controller.signal });
        const payload = await readPayload(response);
        if (selected !== request.current) return;
        if (Array.isArray(payload)) {
          // Older servers ignore `limit` and answer with the legacy array.
          const all = sortLegacy(payload as Book[], query.sort);
          legacy.current = all;
          const page = legacyWindow(all, 0);
          setBooks(page.items);
          setTotal(all.length);
          setNextCursor(page.nextCursor);
        } else if (isBookPage(payload)) {
          legacy.current = null;
          setBooks(payload.items);
          setTotal(payload.total);
          setNextCursor(payload.nextCursor);
        } else {
          throw new Error("The library returned an unexpected response.");
        }
      } catch (e) {
        if (controller.signal.aborted || selected !== request.current) return;
        setError(formatError(e));
      } finally {
        if (selected === request.current) {
          setLoading(false);
          if (firstPage.current === controller) firstPage.current = null;
        }
      }
    },
    [api, currentQuery],
  );

  useEffect(() => {
    void loadFirstPage("replace");
  }, [debouncedQuery, filtersKey, loadFirstPage, params.order, params.sort]);

  useEffect(
    () => () => {
      firstPage.current?.abort();
      morePage.current?.abort();
      hydratePage.current?.abort();
    },
    [],
  );

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    // A first page in flight will replace the cursor; appending against the old one could
    // mix generations and resurface stale rows after the refresh.
    if (!cursor || loadingMoreRef.current || firstPage.current) return;
    if (cursor.startsWith(LEGACY_CURSOR) && legacy.current) {
      const offset = Number(cursor.slice(LEGACY_CURSOR.length));
      const page = legacyWindow(legacy.current, offset);
      setBooks((existing) => mergeById(existing, page.items));
      setNextCursor(page.nextCursor);
      return;
    }
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError("");
    const selected = request.current;
    const token = ++moreRequest.current;
    morePage.current?.abort();
    const controller = new AbortController();
    morePage.current = controller;
    try {
      const response = await api(booksPath(currentQuery(), cursor), { signal: controller.signal });
      const payload = await readPayload(response);
      if (selected !== request.current) return;
      if (Array.isArray(payload)) {
        const all = payload as Book[];
        legacy.current = all;
        const page = legacyWindow(all, booksRef.current.length);
        setBooks((existing) => mergeById(existing, page.items));
        setTotal(all.length);
        setNextCursor(page.nextCursor);
      } else if (isBookPage(payload)) {
        legacy.current = null;
        setBooks((existing) => mergeById(existing, payload.items));
        setTotal(payload.total);
        setNextCursor(payload.nextCursor);
      } else {
        throw new Error("The library returned an unexpected response.");
      }
    } catch (e) {
      if (controller.signal.aborted || selected !== request.current) return;
      if (e instanceof ApiError && e.status === 400) {
        // Cursor v1 (or a cursor from another query) is rejected: start over from page one.
        await loadFirstPage("refresh");
        return;
      }
      setError(formatError(e));
    } finally {
      // Only the newest page load owns the "loading more" state. An older request that
      // was superseded (by a refresh/search or by another page load) must not clear it.
      if (token === moreRequest.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
        morePage.current = null;
      }
    }
  }, [api, currentQuery, loadFirstPage]);

  /**
   * Silently re-reads the first page. Replacing instead of merging drops books removed by
   * a scan/source change, and takes the fresh cursor so pagination never resumes mid-list.
   */
  const refresh = useCallback(() => loadFirstPage("refresh"), [loadFirstPage]);

  const retry = useCallback(() => loadFirstPage("replace"), [loadFirstPage]);

  /**
   * Refreshes only the visible rows that can still change. Revisions arrive every
   * few seconds during a backfill, so the throttle keeps the network quiet.
   */
  const hydrateVisible = useCallback(
    async (ids: string[]) => {
      const now = Date.now();
      if (now - lastHydrate.current < HYDRATE_THROTTLE_MS) return;
      const candidates = booksRef.current.filter((book) => ids.includes(book.id) && needsHydration(book));
      const targets = [...new Set(candidates.map((book) => book.id))].slice(0, HYDRATE_MAX_IDS);
      if (targets.length === 0) return;
      lastHydrate.current = now;
      const selected = request.current;
      hydratePage.current?.abort();
      const controller = new AbortController();
      hydratePage.current = controller;
      try {
        const response = await api(idsPath(targets), { signal: controller.signal });
        const payload: unknown = await response.json();
        if (selected !== request.current || controller.signal.aborted) return;
        const items = Array.isArray(payload) ? (payload as Book[]) : isBookPage(payload) ? payload.items : [];
        const found = new Map(items.filter((book) => targets.includes(book.id)).map((book) => [book.id, book]));
        if (found.size === 0) return;
        if (legacy.current) legacy.current = legacy.current.map((book) => found.get(book.id) ?? book);
        setBooks((existing) => existing.map((book) => found.get(book.id) ?? book));
      } catch {
        // Best effort: the next revision tries again after the throttle window.
      } finally {
        if (hydratePage.current === controller) hydratePage.current = null;
      }
    },
    [api],
  );

  const removeBook = useCallback((id: string) => {
    if (legacy.current) legacy.current = legacy.current.filter((book) => book.id !== id);
    setBooks((current) => current.filter((book) => book.id !== id));
    setTotal((current) => Math.max(0, current - 1));
  }, []);

  /** Optimistic tag membership; the caller refreshes to roll back a failed request. */
  const patchTagIds = useCallback(
    (predicate: (book: Book) => boolean, add: string[], remove: string[]) => {
      const apply = (book: Book): Book => {
        if (!predicate(book)) return book;
        const ids = new Set(book.tagIds ?? []);
        for (const id of add) ids.add(id);
        for (const id of remove) ids.delete(id);
        return { ...book, tagIds: [...ids] };
      };
      if (legacy.current) legacy.current = legacy.current.map(apply);
      setBooks((current) => current.map(apply));
    },
    [],
  );

  /** Optimistic favorite flag; the caller restores the previous value on failure. */
  const patchFavorites = useCallback(
    (predicate: (book: Book) => boolean, favorite: boolean) => {
      const apply = (book: Book): Book => (predicate(book) ? { ...book, favorite } : book);
      if (legacy.current) legacy.current = legacy.current.map(apply);
      setBooks((current) => current.map(apply));
    },
    [],
  );

  useAutoDismiss(notice, setNotice);

  return {
    books,
    total,
    loading,
    loadingMore,
    hasMore: nextCursor !== null,
    notice,
    setNotice,
    error,
    setError,
    loadMore,
    refresh,
    retry,
    hydrateVisible,
    removeBook,
    patchTagIds,
    patchFavorites,
  };
}
