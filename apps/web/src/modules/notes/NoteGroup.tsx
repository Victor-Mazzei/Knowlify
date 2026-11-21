import { useId } from "react";
import { Link } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { useCover } from "../library/useCoverQueue";
import { NoteListItem } from "./NoteListItem";
import type { Note, NoteBook, NoteGroup as NoteGroupData, NoteGroupStatus } from "./types";

const formatDate = (value: number) =>
  new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function GroupCover({ book, api }: { book: NoteBook; api: ApiFn }) {
  const url = useCover({ id: book.id, hasCover: book.hasCover, status: "ready" }, api);
  return (
    <span className="note-group-cover" aria-hidden="true">
      {url ? (
        <img src={url} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="note-group-cover-format">{book.format.toUpperCase()}</span>
      )}
    </span>
  );
}

export function NoteGroup({
  group,
  api,
  query,
  collapsed,
  onToggle,
  onDelete,
  deletingId,
  deleteError,
  status,
  onShowAll,
  registerDeleteButton,
}: {
  group: NoteGroupData;
  api: ApiFn;
  query: string;
  collapsed: boolean;
  onToggle: () => void;
  onDelete: (note: Note) => void;
  deletingId: string | null;
  deleteError: { id: string; message: string } | null;
  status?: NoteGroupStatus;
  onShowAll: () => void;
  registerDeleteButton: (id: string, element: HTMLButtonElement | null) => void;
}) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const bodyId = `${baseId}-notes`;
  const searching = query.trim().length > 0;
  const loading = status?.loading === true;
  return (
    <section className="note-group" aria-labelledby={titleId} data-collapsed={collapsed || undefined}>
      <header className="note-group-head">
        <GroupCover book={group.book} api={api} />
        <div className="note-group-title">
          <h2 id={titleId}>
            <Link to={`/book/${group.book.id}`}>{group.book.title}</Link>
          </h2>
          <p className="note-group-author">{group.book.author || "Unknown author"}</p>
          <p className="note-group-meta">
            <span className="note-group-count">
              {group.noteCount} {group.noteCount === 1 ? "note" : "notes"}
            </span>
            <span className="note-group-last">
              Last note{" "}
              <time dateTime={new Date(group.lastNoteAt).toISOString()}>
                {formatDate(group.lastNoteAt)}
              </time>
            </span>
          </p>
        </div>
        {!searching && (
          <button
            type="button"
            className="note-group-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={`${collapsed ? "Expand" : "Collapse"} notes for ${group.book.title}`}
            onClick={onToggle}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        )}
      </header>
      <div id={bodyId} className="note-group-body" hidden={collapsed}>
        <div className="note-entries">
          {group.notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              bookTitle={group.book.title}
              query={query}
              deleting={deletingId === note.id}
              deleteError={deleteError?.id === note.id ? deleteError.message : undefined}
              onDelete={onDelete}
              registerDeleteButton={registerDeleteButton}
            />
          ))}
        </div>
        {(group.hasMore || status?.error) && (
          <div className="note-group-more-row">
            <button
              type="button"
              className="ghost bordered note-group-more"
              disabled={loading}
              onClick={onShowAll}
            >
              {loading
                ? "Loading notes…"
                : status?.error
                  ? "Retry loading notes"
                  : `Show all ${group.noteCount} notes`}
            </button>
          </div>
        )}
        {status?.error && (
          <p className="error note-group-error" role="alert">
            Could not load all notes from this book: {status.error}
          </p>
        )}
      </div>
    </section>
  );
}
