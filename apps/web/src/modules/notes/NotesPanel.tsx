import { useState } from "react";
import { useConfirm } from "../../components/dialogs";
import type { Note, Selection } from "./types";
import { newsQueryFromQuote } from "../news/query";

export function NotesPanel({
  notes,
  selection,
  where,
  onClose,
  onClearSelection,
  onAdd,
  onUpdate,
  onDelete,
  onJump,
  onNewsAbout,
}: {
  notes: Note[];
  selection?: Selection;
  where: string;
  onClose: () => void;
  onClearSelection: () => void;
  onAdd: (body: string) => Promise<void>;
  onUpdate: (note: Note, body: string) => Promise<void>;
  onDelete: (note: Note) => Promise<void>;
  onJump: (note: Note) => void;
  onNewsAbout?: (text: string) => void;
}) {
  const { ask, dialog: confirmDialog } = useConfirm();
  const [draft, setDraft] = useState(""),
    [editing, setEditing] = useState<string>(),
    [editDraft, setEditDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState("");
  const shown = filter.trim()
    ? notes.filter((n) => `${n.body} ${n.quote}`.toLowerCase().includes(filter.trim().toLowerCase()))
    : notes;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd(draft);
      setDraft("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="notes-panel" aria-label="Notes">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Notes</p>
          <h2>{notes.length} {notes.length === 1 ? "note" : "notes"}</h2>
        </div>
        <button className="close" aria-label="Close notes" onClick={onClose}>
          ×
        </button>
      </div>
      <form className="note-form" onSubmit={submit}>
        {selection && (
          <blockquote className="note-quote">
            “{selection.text.length > 240 ? `${selection.text.slice(0, 240)}…` : selection.text}”
            <button type="button" className="ghost" onClick={onClearSelection}>
              Remove quote
            </button>
          </blockquote>
        )}
        <textarea
          aria-label="New note"
          placeholder={selection ? "Note about the selected text" : `Note at ${where}`}
          value={draft}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void submit(event);
          }}
        />
        <div className="note-actions">
          <small>{selection ? "Quote attached" : where}</small>
          <button className="primary" disabled={!draft.trim() || busy}>
            Add note
          </button>
        </div>
      </form>
      {notes.length > 3 && (
        <input
          className="note-filter"
          aria-label="Filter notes"
          placeholder="Filter notes in this book"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <ul className="note-list">
        {shown.map((note) => (
          <li key={note.id} className="note">
            <div className="note-meta">
              <button className="note-jump" onClick={() => onJump(note)} title="Go to this passage">
                {note.label || "Go to"}
              </button>
              <small>{new Date(note.updatedAt).toLocaleDateString()}</small>
            </div>
            {note.quote && <blockquote className="note-quote">“{note.quote}”</blockquote>}
            {editing === note.id ? (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!editDraft.trim()) return;
                  await onUpdate(note, editDraft);
                  setEditing(undefined);
                }}
              >
                <textarea aria-label="Edit note" rows={3} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} />
                <div className="note-actions">
                  <button type="button" className="ghost" onClick={() => setEditing(undefined)}>
                    Cancel
                  </button>
                  <button className="primary" disabled={!editDraft.trim()}>
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="note-body">{note.body}</p>
                <div className="note-actions">
                  {note.quote && onNewsAbout && <button className="ghost" onClick={() => onNewsAbout(newsQueryFromQuote(note.quote))}>News about this quote</button>}
                  <button
                    className="ghost"
                    onClick={() => {
                      setEditing(note.id);
                      setEditDraft(note.body);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="ghost danger-action"
                    onClick={async () => {
                      const ok = await ask({
                        title: "Delete this note?",
                        message: note.quote ? <>“{note.quote.length > 120 ? `${note.quote.slice(0, 120)}…` : note.quote}”</> : <>{note.body.length > 140 ? `${note.body.slice(0, 140)}…` : note.body}</>,
                        confirmLabel: "Delete note",
                        danger: true,
                      });
                      if (ok) await onDelete(note);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
        {shown.length === 0 && (
          <li className="muted note-empty">
            {notes.length ? "No notes match." : "No notes yet. Select text in the book to attach a quote."}
          </li>
        )}
      </ul>
      {confirmDialog}
    </aside>
  );
}
