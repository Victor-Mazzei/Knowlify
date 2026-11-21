import { NotFoundError } from "../domain/errors.js";
import {
  clean,
  encodeNoteGroupCursor,
  noteBody,
  noteGroupQuery,
  noteQuery,
  type NoteGroupQueryInput,
  type NoteInput,
} from "../domain/reading/Note.js";
import type { Note, NoteGroupBook, NoteRepository, BookRepository, Clock, IdGenerator } from "../ports/index.js";

export interface NoteGroupView {
  book: NoteGroupBook;
  noteCount: number;
  lastNoteAt: number;
  notes: (Note & { book_title: string })[];
  hasMore: boolean;
}

export interface NoteGroupsPage {
  groups: NoteGroupView[];
  nextCursor: string | null;
  totalBooks: number;
  totalNotes: number;
}

export class Notes {
  constructor(private notes: NoteRepository, private books: BookRepository, private clock: Clock, private ids: IdGenerator) {}
  search(q?: string, limit?: string) {
    return this.notes.search(q?.trim(), Math.min(Math.max(Number(limit) || 100, 1), 500));
  }
  list(bookId: string, q?: string) {
    const query = noteQuery(q);
    return query === undefined ? this.notes.list(bookId) : this.notes.listMatching(bookId, query);
  }
  /**
   * Page of books ordered by their most recent matching note. Three data queries (groups,
   * group notes, books) plus the two counters; never one query per book.
   */
  groups(input?: NoteGroupQueryInput): NoteGroupsPage {
    const query = noteGroupQuery(input);
    const { rows, nextAnchor } = this.notes.groups(query.q, query.limit, query.anchor);
    const bookIds = rows.map((row) => row.bookId);
    const notes = this.notes.forGroups(bookIds, query.q, query.perGroup);
    const booksById = new Map(this.notes.booksForGroups(bookIds).map((book) => [book.id, book]));
    const notesByBook = new Map<string, Note[]>();
    for (const note of notes) {
      const groupNotes = notesByBook.get(note.book_id);
      if (groupNotes) groupNotes.push(note);
      else notesByBook.set(note.book_id, [note]);
    }
    const groups: NoteGroupView[] = [];
    for (const row of rows) {
      const book = booksById.get(row.bookId);
      if (!book) continue;
      const groupNotes = (notesByBook.get(row.bookId) ?? []).map((note) => ({ ...note, book_title: book.title }));
      groups.push({
        book,
        noteCount: row.noteCount,
        lastNoteAt: row.lastNoteAt,
        notes: groupNotes,
        hasMore: row.noteCount > groupNotes.length,
      });
    }
    const totals = this.notes.countMatching(query.q);
    return {
      groups,
      nextCursor: nextAnchor === null ? null : encodeNoteGroupCursor(nextAnchor),
      totalBooks: totals.books,
      totalNotes: totals.notes,
    };
  }
  add(bookId: string, input?: NoteInput): Note {
    if (!this.books.get(bookId)) throw new NotFoundError("Not found");
    const body = noteBody(input?.body);
    const now = this.clock.now();
    const note: Note = { id: this.ids.next(), book_id: bookId, body, quote: clean(input?.quote, 5_000),
      label: clean(input?.label, 200), location: clean(input?.location, 2_000), created_at: now, updated_at: now };
    this.notes.save(note);
    return note;
  }
  update(id: string, input?: NoteInput): Note {
    const body = noteBody(input?.body);
    const note = this.notes.get(id);
    if (!note) throw new NotFoundError("Not found");
    const updated = { ...note, body, updated_at: this.clock.now() };
    this.notes.save(updated);
    return updated;
  }
  delete(id: string): void { if (!this.notes.delete(id)) throw new NotFoundError("Not found"); }
}
