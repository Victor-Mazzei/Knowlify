import { Link } from "react-router-dom";
import { Highlight } from "./Highlight";
import type { Note } from "./types";

const excerpt = (note: Note) => {
  const text = note.quote || note.body;
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

export const noteReaderPath = (note: Note) =>
  `/read/${note.bookId}${note.location ? `?at=${encodeURIComponent(note.location)}` : ""}`;

const deleteLabel = (note: Note, bookTitle: string) => {
  const preview = excerpt(note);
  return `Delete note from ${bookTitle}${preview ? `: ${preview}` : ""}`;
};

export function NoteListItem({
  note,
  bookTitle,
  query,
  showBook = false,
  deleting,
  deleteError,
  onDelete,
  registerDeleteButton,
}: {
  note: Note;
  bookTitle: string;
  query: string;
  /** Legacy flat list: the card owns the book heading. */
  showBook?: boolean;
  deleting: boolean;
  deleteError?: string;
  onDelete: (note: Note) => void;
  registerDeleteButton: (id: string, element: HTMLButtonElement | null) => void;
}) {
  return (
    <article
      className={showBook ? "note-result" : "note-entry"}
      aria-busy={deleting ? true : undefined}
    >
      <div className={showBook ? "note-result-head" : "note-entry-head"}>
        {showBook ? (
          <h2>
            <Link to={noteReaderPath(note)}>
              <Highlight text={note.bookTitle ?? "Book"} term={query} />
            </Link>
          </h2>
        ) : (
          <div className="note-entry-title">
            <h3>
              <Link to={noteReaderPath(note)} title="Go to this passage">
                <Highlight text={note.label || "Note"} term={query} />
              </Link>
            </h3>
            <small>{new Date(note.updatedAt).toLocaleDateString()}</small>
          </div>
        )}
        <button
          ref={(element) => registerDeleteButton(note.id, element)}
          type="button"
          className={`ghost danger-action note-delete${showBook ? " note-result-delete" : ""}`}
          aria-label={deleteLabel(note, bookTitle)}
          disabled={deleting}
          onClick={() => onDelete(note)}
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
      {showBook && (
        <div className="note-meta">
          <span className="note-jump">{note.label || "Note"}</span>
          <small>{new Date(note.updatedAt).toLocaleDateString()}</small>
        </div>
      )}
      {note.quote && (
        <blockquote className="note-quote">
          “<Highlight text={note.quote} term={query} />”
        </blockquote>
      )}
      <p className="note-body">
        <Highlight text={note.body} term={query} />
      </p>
      {deleteError && (
        <p className="error note-result-error" role="alert">
          Could not delete this note: {deleteError}
        </p>
      )}
    </article>
  );
}
