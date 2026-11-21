import { useContext } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { Book } from "../../types";
import { IndexStatusContext } from "./IndexStatusContext";
import { useEnqueue } from "./useEnqueue";

/**
 * Per-book demand indexing. It stays out of the way: hidden on older servers,
 * on disabled indexing and while the book is already queued, and revealed by
 * the card/row hover or keyboard focus.
 */
export function BookIndexAction({
  book,
  api,
  className = "",
  compact = false,
}: {
  book: Book;
  api: ApiFn;
  className?: string;
  /** Short confirmation for the grid, where the action floats over the cover. */
  compact?: boolean;
}) {
  const context = useContext(IndexStatusContext);
  const { enqueue, busy, error, result } = useEnqueue(api);
  const state = book.index?.state;
  const enabled = context?.available === true && context.status?.enabled === true;

  if (!enabled || !state || state === "pending" || state === "indexing" || book.status !== "ready") return null;

  const run = async () => {
    const next = await enqueue([book.id], true);
    if (next && context) void context.refresh().catch(() => undefined);
  };

  const label = state === "ready" ? "Reindex" : "Index";
  const confirmation = result === null ? null : result.queued > 0 ? "Queued" : "Not queued";

  return (
    <span className="book-index-action">
      <button
        type="button"
        className={`ghost bordered book-index-button${className ? ` ${className}` : ""}`}
        disabled={busy}
        aria-busy={busy}
        aria-label={`${error ? "Retry" : label} ${book.title} for search`}
        title={error || "Queue this book for search indexing"}
        onClick={() => void run()}
      >
        {busy ? "Queueing…" : error ? "Retry" : label}
      </button>
      {confirmation && (
        <span className="book-index-feedback" role="status">
          {compact ? confirmation : result?.queued === 0 ? "Nothing queued." : "Queued for search."}
        </span>
      )}
      {error && (
        <span className="visually-hidden" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
