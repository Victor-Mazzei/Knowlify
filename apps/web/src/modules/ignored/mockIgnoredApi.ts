import type { Book, IgnoredBook } from "../../types";

/** Helper shared with the in-memory API: turns a removed book into an ignored entry. */
export function ignoredEntryFromBook(book: Book, now = Date.now()): IgnoredBook {
  return {
    id: `ignored-${book.id}`,
    title: book.title,
    author: book.author,
    format: book.format,
    size: book.size,
    path: book.source ? `/library/${book.id}.${book.format}` : null,
    sourceId: book.source ? "source-1" : null,
    reason: book.source ? "path" : "content",
    managed: !book.source,
    ignoredAt: now,
  };
}

/** Restoring in the mock recreates a minimal book; the real server re-scans the folder. */
export function restoredBook(entry: IgnoredBook): Book {
  return {
    id: `restored-${entry.id}`,
    title: entry.title,
    author: entry.author,
    format: entry.format,
    size: entry.size,
    addedAt: Date.now(),
    hasCover: false,
    status: "ready",
    source: entry.reason !== "content",
    index: { state: "pending", error: null },
    progress: null,
    tagIds: [],
  };
}
