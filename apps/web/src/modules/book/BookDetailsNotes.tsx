import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { loadBookNotes } from "../notes/notesApi";
import { noteReaderPath as notePath } from "../notes/NoteListItem";
import type { Note } from "../notes/types";

const formatDate = (value: number) =>
  new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const excerpt = (note: Note) => {
  const text = note.quote || note.body;
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};

const PREVIEW_COUNT = 3;

/** The three most recent notes of this book, with a direct jump into the reader. */
export function BookDetailsNotes({ api, bookId }: { api: ApiFn; bookId: string }) {
  const headingId = useId();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setError("");
    setNotes(null);
    void loadBookNotes((path, init) => api(path, { ...init, signal: controller.signal }), bookId, "")
      .then((loaded) => {
        if (active) setNotes(loaded);
      })
      .catch((caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        // A server without the book-notes route simply has no notes to preview.
        const status = caught instanceof Error && "status" in caught ? (caught as { status?: unknown }).status : undefined;
        if (status === 404) setNotes([]);
        else setError(caught instanceof Error ? caught.message : "Could not load notes.");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, attempt, bookId]);

  return (
    <section className="book-details-section book-details-notes" aria-labelledby={headingId}>
      <div className="book-details-section-head">
        <h2 id={headingId}>Notes</h2>
        {notes && notes.length > 0 && (
          <span className="book-details-count">
            {notes.length} {notes.length === 1 ? "note" : "notes"}
          </span>
        )}
        <Link className="book-details-section-link" to="/notes">
          All notes
        </Link>
      </div>
      <div className="book-details-notes-body">
        {error ? (
          <div className="book-details-inline-error" role="alert">
            <span>{error}</span>
            <button type="button" className="ghost bordered" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : notes === null ? (
          <p className="muted book-details-loading" role="status">
            Loading notes…
          </p>
        ) : notes.length === 0 ? (
          <p className="muted">No notes yet. Notes you take while reading appear here.</p>
        ) : (
          <ul className="book-details-note-list">
            {notes.slice(0, PREVIEW_COUNT).map((note) => (
              <li key={note.id} className="book-details-note">
                <div className="book-details-note-head">
                  <Link to={notePath(note)} className="book-details-note-label">
                    {note.label || "Note"}
                  </Link>
                  <small>{formatDate(note.updatedAt)}</small>
                </div>
                <p className="book-details-note-excerpt">{excerpt(note)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
