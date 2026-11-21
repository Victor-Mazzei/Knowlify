export const COLLAPSED_STORAGE_KEY = "knowlify.notes.collapsed";
export const MAX_COLLAPSED_BOOKS = 500;

/** Persisted collapsed books, capped so the preference cannot grow without bound. */
export function readCollapsedBookIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value.filter((id): id is string => typeof id === "string").slice(-MAX_COLLAPSED_BOOKS),
    );
  } catch {
    return new Set();
  }
}

export function saveCollapsedBookIds(ids: Set<string>): void {
  try {
    localStorage.setItem(
      COLLAPSED_STORAGE_KEY,
      JSON.stringify([...ids].slice(-MAX_COLLAPSED_BOOKS)),
    );
  } catch {
    // Blocked storage only loses the preference; the page keeps working.
  }
}

/** Toggles one book and moves it to the newest position in the cap. */
export function toggleCollapsedBook(ids: Set<string>, bookId: string): Set<string> {
  const next = new Set(ids);
  const collapsed = !ids.has(bookId);
  next.delete(bookId);
  if (collapsed) next.add(bookId);
  return new Set([...next].slice(-MAX_COLLAPSED_BOOKS));
}
