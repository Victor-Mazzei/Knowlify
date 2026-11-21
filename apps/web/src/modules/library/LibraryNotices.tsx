import { Link, useLocation } from "react-router-dom";
import { rememberLibraryReturn } from "../book/libraryReturn";
import type { DuplicateUpload } from "./useUpload";

/** Notices above the list: drop target, success message, duplicate upload and errors. */
export function LibraryNotices({
  dragging,
  notice,
  duplicate,
  onDismissDuplicate,
  error,
  onRetry,
}: {
  dragging: boolean;
  notice: string;
  duplicate: DuplicateUpload | null;
  onDismissDuplicate: () => void;
  error: string;
  onRetry: () => void;
}) {
  const search = useLocation().search;
  return (
    <>
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <strong>Drop to add a book</strong>
          <span>PDF or EPUB</span>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {duplicate && (
        <div className="notice notice-action" role="status">
          <span>Already in your library</span>
          <Link
            className="notice-link"
            to={`/book/${duplicate.id}`}
            state={{ from: search }}
            aria-label={duplicate.title ? `Open ${duplicate.title}` : "Open this book"}
            title={duplicate.title || undefined}
            onClick={() => rememberLibraryReturn(search)}
          >
            Open
          </Link>
          <button type="button" className="ghost notice-close" aria-label="Dismiss" onClick={onDismissDuplicate}>
            ×
          </button>
        </div>
      )}
      {error && (
        <div className="error error-row" role="alert">
          <span>{error}</span>
          <button className="ghost bordered" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}
