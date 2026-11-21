import { useEffect, useRef, type MutableRefObject } from "react";

/** Pending return to the Library: its URL query string and the scroll position to restore. */
export const LIBRARY_RETURN_KEY = "knowlify.libraryReturn";
const MAX_SEARCH_LENGTH = 2000;
/** How long a matched return waits for the list to become tall enough to hold the offset. */
export const LIBRARY_RETURN_CONTENT_TIMEOUT_MS = 3000;
/** Gap between content checks; short enough to hide behind late page rendering. */
export const LIBRARY_RETURN_CONTENT_POLL_MS = 50;
const MAX_CONTENT_CHECKS = Math.ceil(LIBRARY_RETURN_CONTENT_TIMEOUT_MS / LIBRARY_RETURN_CONTENT_POLL_MS);

export type LibraryReturn = { search: string; scrollY: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeSearch = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > MAX_SEARCH_LENGTH) return null;
  if (value !== "" && !value.startsWith("?")) return null;
  return value;
};

const storage = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    // Storage can be blocked; the return trip still works, without filters or scroll.
    return null;
  }
};

/** Remembers the current Library URL and scroll offset before opening a book. */
export function rememberLibraryReturn(search: string): void {
  const normalized = normalizeSearch(search);
  if (normalized === null) return;
  const entry: LibraryReturn = {
    search: normalized,
    scrollY: Math.max(0, Math.round(window.scrollY || 0)),
  };
  try {
    storage()?.setItem(LIBRARY_RETURN_KEY, JSON.stringify(entry));
  } catch {
    // Best effort: a full or blocked storage only loses the scroll restoration.
  }
}

export function readLibraryReturn(): LibraryReturn | null {
  let raw: string | null;
  try {
    raw = storage()?.getItem(LIBRARY_RETURN_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const search = normalizeSearch(value.search);
    if (search === null) return null;
    const scrollY = value.scrollY;
    if (typeof scrollY !== "number" || !Number.isFinite(scrollY) || scrollY < 0) return null;
    return { search, scrollY: Math.round(scrollY) };
  } catch {
    return null;
  }
}

export function clearLibraryReturn(): void {
  try {
    storage()?.removeItem(LIBRARY_RETURN_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/** The href for the breadcrumb: the Library query string captured on the way out. */
export function libraryHref(search: string): string {
  const normalized = normalizeSearch(search);
  return normalized ? `/${normalized}` : "/";
}

/**
 * True when the current Library URL still shows the remembered view. The URL is
 * the navigation correlation: an entry must only ever restore the visit it was
 * saved for. A sort that the remembered URL did not carry may have been
 * materialized into the current one on load, so that single key is optional on
 * the saved side. Every other difference (query, filters, a different sort) is
 * another navigation and must not inherit the offset.
 */
export function librarySearchMatches(remembered: string, current: string): boolean {
  const saved = normalizeSearch(remembered);
  if (saved === null) return false;
  const savedParams = new URLSearchParams(saved);
  const currentParams = new URLSearchParams(current.startsWith("?") ? current.slice(1) : current);
  const keys = new Set([...savedParams.keys(), ...currentParams.keys()]);
  for (const key of keys) {
    if (key === "sort") continue;
    if (savedParams.getAll(key).join("\u0000") !== currentParams.getAll(key).join("\u0000")) return false;
  }
  const savedSort = savedParams.get("sort");
  return savedSort === null || currentParams.get("sort") === savedSort;
}

export type LibraryReturnScrollOptions = {
  /** Query string of this Library visit (`?q=river` or `q=river`). */
  search: string;
  /** The first page settled: loading finished, successfully or not. */
  loaded: boolean;
  /** The settled page has no results, so there is no offset to restore. */
  empty: boolean;
};

/**
 * Consumes the pending Library return for this visit.
 *
 * The entry belongs to one Library URL. It is claimed only when the visit
 * matches that URL and discarded as soon as any other Library URL is shown, so
 * an unrelated navigation never inherits an old offset and never blocks the
 * normal reset to the top. Once the first page settles, the entry is consumed
 * exactly once: immediately for an empty result or no offset, otherwise after
 * the rendered page becomes tall enough to hold the offset. The wait is
 * bounded; a page that never reaches the offset stays at the top.
 *
 * The returned ref is false again as soon as the entry is consumed or
 * cancelled, which is when a later list change must reset the scroll.
 */
export function useLibraryReturnScroll({
  search,
  loaded,
  empty,
}: LibraryReturnScrollOptions): MutableRefObject<boolean> {
  const pending = useRef(false);
  const entry = useRef<LibraryReturn | null>(null);
  const mountSearch = useRef(search);
  const claimed = useRef(false);

  // Claim the stored return for this navigation, or drop one meant for another URL.
  useEffect(() => {
    if (claimed.current) return;
    claimed.current = true;
    const stored = readLibraryReturn();
    if (!stored) return;
    if (!librarySearchMatches(stored.search, mountSearch.current)) {
      clearLibraryReturn();
      return;
    }
    entry.current = stored;
    pending.current = true;
  }, []);

  // A later URL change makes the pending return obsolete and unblocks the reset.
  useEffect(() => {
    const current = entry.current;
    if (!current) return;
    if (librarySearchMatches(current.search, search)) return;
    entry.current = null;
    pending.current = false;
    clearLibraryReturn();
  }, [search]);

  useEffect(() => {
    if (!pending.current) return;
    const current = entry.current;
    if (!current) return;
    if (!loaded) return;
    const consume = () => {
      entry.current = null;
      pending.current = false;
      clearLibraryReturn();
    };
    if (empty || current.scrollY <= 0) {
      consume();
      if (empty && window.scrollY > 0) window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    let checks = 0;
    let cancelled = false;
    let timer: number | null = null;
    const attempt = () => {
      if (cancelled || !pending.current || entry.current !== current) return;
      const enoughContent = document.documentElement.scrollHeight >= current.scrollY + window.innerHeight;
      if (enoughContent) {
        window.scrollTo({ top: current.scrollY, behavior: "auto" });
        consume();
        return;
      }
      checks += 1;
      if (checks > MAX_CONTENT_CHECKS) {
        consume();
        if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      timer = window.setTimeout(attempt, LIBRARY_RETURN_CONTENT_POLL_MS);
    };
    timer = window.setTimeout(attempt, 0);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [empty, loaded]);

  return pending;
}
