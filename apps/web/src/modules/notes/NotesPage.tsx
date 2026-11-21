import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { useConfirm } from "../../components/dialogs";
import { useApi } from "../../services/api";
import type { Credentials } from "../../types";
import { mockNotesApi } from "./mockNotesApi";
import { NoteGroup } from "./NoteGroup";
import { NoteListItem } from "./NoteListItem";
import {
  readCollapsedBookIds,
  saveCollapsedBookIds,
  toggleCollapsedBook,
} from "./collapsedNotes";
import { useNoteGroups } from "./useNoteGroups";
import type { Note } from "./types";
import "./notes.css";

const excerpt = (note: Note) => {
  const text = note.quote || note.body;
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

/** Opt-in dev fixture: render the notes page without a server. */
const devMock = import.meta.env.VITE_MOCK_NOTES === "1" ? mockNotesApi() : null;

export function NotesPage({
  credentials,
  onLogout,
  apiOverride,
}: {
  credentials: Credentials;
  onLogout: () => void;
  /** Test seam: inject a fixture API without changing the auth hook. */
  apiOverride?: ApiFn;
}) {
  const liveApi = useApi(credentials, onLogout);
  const api = apiOverride ?? devMock ?? liveApi;
  const { ask, dialog: confirmDialog } = useConfirm();
  const [query, setQuery] = useState("");
  const [collapsedIds, setCollapsedIds] = useState(readCollapsedBookIds);
  const searchRef = useRef<HTMLInputElement>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterDelete = useRef<{ noteId?: string } | null>(null);
  const notes = useNoteGroups(api, query);

  const loadedNotes = useMemo(
    () =>
      notes.state.mode === "groups"
        ? notes.state.groups.flatMap((group) => group.notes)
        : notes.state.flatNotes,
    [notes.state],
  );

  useEffect(() => {
    const target = focusAfterDelete.current;
    if (!target) return;
    focusAfterDelete.current = null;
    const button = target.noteId ? deleteButtons.current.get(target.noteId) : undefined;
    const visible = button && !button.closest("[hidden]");
    (visible ? button : searchRef.current)?.focus();
  }, [loadedNotes]);

  const registerDeleteButton = useCallback(
    (id: string, element: HTMLButtonElement | null) => {
      if (element) deleteButtons.current.set(id, element);
      else deleteButtons.current.delete(id);
    },
    [],
  );

  const toggleGroup = useCallback((bookId: string) => {
    setCollapsedIds((current) => {
      const next = toggleCollapsedBook(current, bookId);
      saveCollapsedBookIds(next);
      return next;
    });
  }, []);

  async function requestDelete(note: Note) {
    const ok = await ask({
      title: "Delete this note?",
      message: note.quote ? <>“{excerpt(note)}”</> : <>{excerpt(note)}</>,
      confirmLabel: "Delete note",
      danger: true,
    });
    if (!ok) return;
    const index = loadedNotes.findIndex((item) => item.id === note.id);
    const next = loadedNotes[index + 1] ?? loadedNotes[index - 1];
    focusAfterDelete.current = next ? { noteId: next.id } : {};
    if (!(await notes.remove(note))) focusAfterDelete.current = null;
  }

  const searching = query.trim().length > 0;
  const summary =
    notes.state.mode === "groups"
      ? `${plural(notes.state.totalNotes, "note")} in ${plural(notes.state.totalBooks, "book")}`
      : plural(notes.state.flatNotes.length, "note");
  const empty = notes.state.mode === "groups" ? notes.state.totalNotes === 0 : notes.state.flatNotes.length === 0;
  const loaded = notes.state.mode === "groups" ? notes.state.groups.length : notes.state.flatNotes.length;
  // Keep the current results visible during a search so the page does not jump to a skeleton.
  const refreshing = notes.loading && loaded > 0;

  return (
    <>
      <main className="library notes-page">
        <section className="intro">
          <p className="eyebrow">Reading notes</p>
          <h1>Notes</h1>
          <p className="lede">Everything you wrote while reading, grouped by book and ordered by the latest note.</p>
        </section>
        <div className="toolbar">
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              aria-label="Search notes"
              placeholder="Search notes"
              value={query}
              maxLength={200}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span
            className="count notes-count"
            role={notes.loading ? undefined : "status"}
            aria-live={notes.loading ? undefined : "polite"}
          >
            {notes.loading
              ? refreshing
                ? "Searching…"
                : "Loading notes…"
              : notes.error
                ? "Notes unavailable"
                : summary}
          </span>
        </div>
        {notes.error && (
          <div className="error error-row" role="alert">
            <span>{notes.error}</span>
            <button type="button" className="ghost bordered" onClick={notes.retry}>
              Retry
            </button>
          </div>
        )}
        {notes.loading && !refreshing ? (
          <div className="note-groups" aria-busy="true">
            <p className="visually-hidden" role="status">
              Loading notes…
            </p>
            {[0, 1, 2].map((key) => (
              <div key={key} className="note-group-skeleton" aria-hidden="true" />
            ))}
          </div>
        ) : notes.error ? null : empty && !notes.loading ? (
          <div className="empty">
            <strong>{searching ? "No matching notes." : "No notes yet."}</strong>
            <span>
              {searching
                ? "Try another word."
                : "Open a book and use the Notes button to start."}
            </span>
          </div>
        ) : notes.state.mode === "legacy" ? (
          <div className="notes-search-results" aria-busy={notes.loading || undefined}>
            {notes.state.flatNotes.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                bookTitle={note.bookTitle ?? "this book"}
                query={query.trim()}
                showBook
                deleting={notes.deleting === note.id}
                deleteError={notes.deleteError?.id === note.id ? notes.deleteError.message : undefined}
                onDelete={(item) => void requestDelete(item)}
                registerDeleteButton={registerDeleteButton}
              />
            ))}
          </div>
        ) : (
          <>
            <div className="note-groups" aria-busy={notes.loading || undefined}>
              {notes.state.groups.map((group) => (
                <NoteGroup
                  key={group.book.id}
                  group={group}
                  api={api}
                  query={query.trim()}
                  collapsed={!searching && collapsedIds.has(group.book.id)}
                  onToggle={() => toggleGroup(group.book.id)}
                  onDelete={(note) => void requestDelete(note)}
                  deletingId={notes.deleting}
                  deleteError={notes.deleteError}
                  status={notes.groupStatus[group.book.id]}
                  onShowAll={() => void notes.loadAllNotes(group.book.id)}
                  registerDeleteButton={registerDeleteButton}
                />
              ))}
            </div>
            {notes.state.nextCursor && (
              <div className="notes-more-row">
                <button
                  type="button"
                  className="ghost bordered notes-load-more"
                  disabled={notes.loadingMore}
                  onClick={() => void notes.loadMore()}
                >
                  {notes.loadingMore ? "Loading…" : "Load more books"}
                </button>
              </div>
            )}
            {notes.moreError && (
              <div className="error error-row" role="alert">
                <span>Could not load more books: {notes.moreError}</span>
                <button type="button" className="ghost bordered" onClick={() => void notes.loadMore()}>
                  Retry
                </button>
              </div>
            )}
          </>
        )}
      </main>
      {confirmDialog}
    </>
  );
}
