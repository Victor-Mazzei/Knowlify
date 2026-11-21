import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { useApi } from "../../services/api";
import type { Credentials } from "../../types";
import { DeleteBooksDialog } from "../library/DeleteBooksDialog";
import { BookDetailsSkeleton } from "./BookDetailsSkeleton";
import { BookDetailsView } from "./BookDetailsView";
import { devBooksApi } from "./devApi";
import { libraryHref, readLibraryReturn } from "./libraryReturn";
import { EditMetadataDialog } from "./metadata/EditMetadataDialog";
import { FindMetadataDialog } from "./metadata/FindMetadataDialog";
import type { BookDetail } from "./types";
import { useBook } from "./useBook";
import { useMetadataCapability } from "./useMetadataCapability";
import "./bookDetails.css";

const devMock = devBooksApi();

/** The Library query string the details page was opened from, if any. */
function librarySearchOf(state: unknown): string {
  if (typeof state === "object" && state !== null && "from" in state) {
    const from = (state as { from?: unknown }).from;
    if (typeof from === "string" && (from === "" || from.startsWith("?"))) return from;
  }
  return readLibraryReturn()?.search ?? "";
}

export function BookDetailsPage({
  credentials,
  onLogout,
  apiOverride,
}: {
  credentials: Credentials;
  onLogout: () => void;
  /** Test seam: inject a fixture API without changing the auth hook. */
  apiOverride?: ApiFn;
}) {
  const { id = "" } = useParams();
  const liveApi = useApi(credentials, onLogout);
  const api = apiOverride ?? devMock ?? liveApi;
  const state = useBook(api, id);
  const capability = useMetadataCapability(api);
  const navigate = useNavigate();
  const location = useLocation();
  const [editing, setEditing] = useState(false);
  const [finding, setFinding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const returnSearch = useMemo(() => librarySearchOf(location.state), [location.state]);
  const returnHref = libraryHref(returnSearch);
  const at = new URLSearchParams(location.search).get("at");
  const readHref = `/read/${encodeURIComponent(id)}${at ? `?at=${encodeURIComponent(at)}` : ""}`;
  const title = state.book?.title;

  useEffect(() => {
    setEditing(false);
    setFinding(false);
    setDeleting(false);
  }, [id]);

  useEffect(() => {
    if (!title) return;
    document.title = `${title} · Knowlify`;
    return () => {
      document.title = "Knowlify Library";
    };
  }, [title]);

  // The dialogs stay open after a save: the page only refreshes its detail (and cover).
  function saved(next: BookDetail) {
    state.update(next);
  }

  return (
    <>
      {state.loading ? (
        <BookDetailsSkeleton />
      ) : state.notFound ? (
        <main className="book-details book-details-state">
          <nav className="book-details-crumbs" aria-label="Breadcrumb">
            <Link to={returnHref}>Library</Link>
          </nav>
          <h1>Book not found</h1>
          <p className="muted">
            This book may have been removed from the library, or the link is out of date.
          </p>
          <Link className="primary book-details-read" to={returnHref}>
            Back to Library
          </Link>
        </main>
      ) : state.error || !state.book ? (
        <main className="book-details book-details-state">
          <nav className="book-details-crumbs" aria-label="Breadcrumb">
            <Link to={returnHref}>Library</Link>
          </nav>
          <div className="error book-details-inline-error" role="alert">
            <span>{state.error || "The book could not be loaded."}</span>
            <button type="button" className="ghost bordered" onClick={state.reload}>
              Try again
            </button>
          </div>
        </main>
      ) : (
        <>
          <main className="book-details">
            <nav className="book-details-crumbs" aria-label="Breadcrumb">
              <Link to={returnHref}>Library</Link>
              <span aria-hidden="true">/</span>
              <span aria-current="page">{state.book.title}</span>
            </nav>
            <BookDetailsView
              book={state.book}
              api={api}
              capability={capability}
              readHref={readHref}
              onBookChange={state.update}
              onEdit={() => setEditing(true)}
              onFind={() => setFinding(true)}
              onDelete={() => setDeleting(true)}
            />
          </main>
          {editing && (
            <EditMetadataDialog book={state.book} api={api} onClose={() => setEditing(false)} onSaved={saved} />
          )}
          {finding && (
            <FindMetadataDialog book={state.book} api={api} onClose={() => setFinding(false)} onSaved={saved} />
          )}
          {deleting && (
            <DeleteBooksDialog
              api={api}
              selection={{ ids: [state.book.id] }}
              onDeleted={() => {
                setDeleting(false);
                navigate(returnHref, { replace: true });
              }}
              onClose={() => setDeleting(false)}
            />
          )}
        </>
      )}
    </>
  );
}
