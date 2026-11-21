import type { Book } from "../../types";
import type { BookIndexState } from "./types";

const LABEL: Record<Exclude<BookIndexState, "ready" | "none">, string> = {
  pending: "Queued for search",
  indexing: "Indexing for search",
  error: "Search index failed",
};

/** Small per-book status; silent once the book is searchable. */
export function BookIndexNote({ book }: { book: Book }) {
  const index = book.index;
  if (!index || index.state === "ready" || index.state === "none") return null;
  return (
    <small className={`book-index-note${index.state === "error" ? " error-status" : ""}`} title={index.error?.message}>
      {LABEL[index.state]}
    </small>
  );
}
