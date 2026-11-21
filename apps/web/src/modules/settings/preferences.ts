import type { BookSort } from "../../types";

export const FONT_KEY = "knowlify.reader.fontSize";
export const FONT_MIN = 80;
export const FONT_MAX = 200;

export function readFontSize() {
  try {
    const value = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(value) && value >= FONT_MIN && value <= FONT_MAX ? value : 100;
  } catch {
    return 100;
  }
}

export type LibraryView = "grid" | "table";

export function readLibraryView(): LibraryView {
  try {
    return localStorage.getItem("knowlify.view") === "table" ? "table" : "grid";
  } catch {
    return "grid";
  }
}

export function saveLibraryView(view: LibraryView) {
  try {
    localStorage.setItem("knowlify.view", view);
  } catch {
    /* storage unavailable */
  }
}

export const LIBRARY_SORT_KEY = "knowlify.library.sort";
const LIBRARY_SORTS: readonly BookSort[] = ["added", "title", "lastRead", "author", "reading"];

/**
 * Last sort chosen by the person; the URL still wins whenever it carries one.
 * `null` means nobody has chosen yet, so the library falls back to its own
 * default (`reading`) instead of pretending `added` was saved.
 */
export function readLibrarySort(): BookSort | null {
  try {
    const value = localStorage.getItem(LIBRARY_SORT_KEY);
    return LIBRARY_SORTS.find((sort) => sort === value) ?? null;
  } catch {
    return null;
  }
}

export function saveLibrarySort(sort: BookSort) {
  try {
    localStorage.setItem(LIBRARY_SORT_KEY, sort);
  } catch {
    /* storage unavailable */
  }
}
