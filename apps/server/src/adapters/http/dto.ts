import type { Book, Note, StoredProgress } from "../../ports/index.js";
import type { BookIndex } from "../../domain/knowledge/BookIndex.js";
import type { NoteGroupView } from "../../use-cases/Notes.js";

export interface BookIndexDto {
  state: "none" | BookIndex["state"];
  error: { code: NonNullable<BookIndex["error"]>["code"]; message: string } | null;
}

/**
 * `none` means the book will not be indexed (feature off or metadata failed). A book with
 * indexing enabled but no row yet is still queued, which the UI reads as pending.
 */
export const bookIndexDto = (book: Book, index: BookIndex | undefined, enabled: boolean): BookIndexDto => {
  if (!enabled || book.status === "error") return { state: "none", error: null };
  if (!index) return { state: "pending", error: null };
  return { state: index.state, error: index.state === "error" ? index.error : null };
};

const progressDto = (p: StoredProgress | undefined): { percentage: number; updatedAt: number } | null => {
  if (!p) return null;
  const percentage = Number.isFinite(p.percentage) ? Math.min(1, Math.max(0, p.percentage)) : 0;
  return { percentage, updatedAt: p.updatedAt };
};

export const toDto = (b: Book, index?: BookIndex, indexingEnabled = false, progress?: StoredProgress, tagIds?: string[]) => ({
  id: b.id,
  title: b.title,
  author: b.author,
  format: b.format,
  size: b.size,
  addedAt: b.added_at,
  hasCover: b.cover_path !== null,
  favorite: b.favorite === 1,
  coverRev: b.cover_rev ?? null,
  status: b.status,
  source: b.source_id !== null,
  index: bookIndexDto(b, index, indexingEnabled),
  progress: progressDto(progress),
  ...(tagIds === undefined ? {} : { tagIds }),
});

export const noteDto = (n: Note & { book_title?: string }) => ({
  id: n.id, bookId: n.book_id, ...(n.book_title !== undefined && { bookTitle: n.book_title }),
  location: n.location, label: n.label, quote: n.quote, body: n.body, createdAt: n.created_at, updatedAt: n.updated_at,
});

/** Group header deliberately omits server paths and every book field the notes UI does not use. */
export const noteGroupDto = (group: NoteGroupView) => ({
  book: group.book,
  noteCount: group.noteCount,
  lastNoteAt: group.lastNoteAt,
  notes: group.notes.map(noteDto),
  hasMore: group.hasMore,
});
