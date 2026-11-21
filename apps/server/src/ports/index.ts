import type { Book } from "../domain/library/Book.js";
import type { Source } from "../domain/library/Source.js";
import type { Note, NoteGroupAnchor, NoteGroupBook, NoteGroupRow } from "../domain/reading/Note.js";
import type { Tag } from "../domain/library/Tag.js";
import type { IgnoredBook } from "../domain/library/IgnoredBook.js";
import type { ReadingProgress, StoredSyncedProgress } from "../domain/reading/ReadingProgress.js";
export type { Book, Source, Note, Tag, IgnoredBook, ReadingProgress, StoredSyncedProgress, NoteGroupAnchor, NoteGroupBook, NoteGroupRow };
export * from "./library-list.js";
export * from "./library-dedup.js";
export * from "./library-tags.js";
export * from "./library-ignore.js";
export * from "./library-metadata.js";
export * from "./metadata-settings.js";
export * from "./library-favorites.js";
/** What the scanner keeps per file to reconcile a source without loading full rows. */
export interface SourceBookSnapshot { id: string; mtime: number | null; size: number }
export interface BookRepository {
  list(q?: string): Book[];
  catalog(q: string, recent: boolean): Book[];
  get(id: string): Book | undefined;
  byPath(path: string): Book | undefined;
  save(book: Book): void;
  /** Inserts or updates a batch in one transaction (ADR-B1). */
  saveMany(books: Book[]): void;
  delete(id: string): void;
  /** Deletes a batch in one transaction (ADR-B1). */
  deleteMany(ids: string[]): void;
  forSource(id: string): Book[];
  deleteSource(id: string): void;
  /** One query instead of one `byPath` per file (ADR-B1). */
  snapshotForSource(id: string): Map<string, SourceBookSnapshot>;
  /** Number of indexed books for a source, without materializing the snapshot. */
  countForSource(id: string): number;
  /**
   * Applies extracted metadata to rows that still exist at the same `mtime`/`size`.
   * Deleted rows are never reinserted. Returns the ids actually updated.
   */
  updateMetadataMany(books: Book[]): string[];
  count(): number;
  pending(limit: number): Book[];
  pendingCount(): number;
  /** Books with this exact size, optionally excluding one path (content identity candidates). */
  bySize(size: number, excludePath?: string): Book[];
  /** Distinct sizes already present in the library, for the scanner's batched dedup check. */
  sizesPresent(sizes: number[]): Set<number>;
  /**
   * Stores a hash only while the row still describes the file that was hashed. Returns
   * false when the file changed between the hash and the write. When the row has no mtime
   * yet (managed upload) and `observedMtime` is given, the mtime seen while reading is
   * stored with the hash so later revalidation can compare the real file.
   */
  setContentHashIfCurrent(id: string, hash: string, size: number, mtime: number | null, observedMtime?: number): boolean;
  /**
   * Drops a hash that no longer describes the file on disk, while the row still has the
   * version the hash was computed for. Returns false when that row changed meanwhile.
   */
  clearContentHashIfCurrent(id: string, size: number, mtime: number | null): boolean;
  /**
   * Copies `book_index.content_hash` into `books.content_hash` when the index fingerprint
   * matches the current size/mtime, avoiding a second read of the file (ADR-2 seed).
   */
  seedContentHashes(size: number): void;
}
export interface SourceRepository { list(): Source[]; byPath(path: string): Source | undefined; save(source: Source): void; delete(id: string): boolean }
export interface NoteRepository {
  search(q: string | undefined, limit: number): (Note & { book_title: string })[];
  list(bookId: string): Note[];
  /**
   * One keyset page of books with notes, ordered by their most recent matching note.
   * Returns `limit + 1` rows internally so the caller knows whether another page exists.
   */
  groups(q: string | undefined, limit: number, anchor?: NoteGroupAnchor): {
    rows: NoteGroupRow[];
    nextAnchor: NoteGroupAnchor | null;
  };
  /** Up to `perGroup` recent notes per group in one window query (no per-book query). */
  forGroups(bookIds: string[], q: string | undefined, perGroup: number): Note[];
  /**
   * Group headers in one query. The plan expected `BookRepository.byIds`, but that method
   * lives on `BookListReader`, which `Notes` is not wired with; keeping the query here
   * avoids an N+1 and does not touch another agent's composition root.
   */
  booksForGroups(bookIds: string[]): NoteGroupBook[];
  /** Totals for the whole matching set, used by the group counter. */
  countMatching(q: string | undefined): { books: number; notes: number };
  /** Notes of one book matching `q` in note fields or in the book title/author. */
  listMatching(bookId: string, q: string): Note[];
  get(id: string): Note | undefined;
  save(note: Note): void;
  delete(id: string): boolean;
  deleteForBook(id: string): void;
  /** Number of notes attached to any of the given books; one query per 500 ids. */
  countForBooks(bookIds: string[]): number;
  /** Moves every note of one book to another and returns the moved ids (merge log). */
  reassign(fromBookId: string, toBookId: string): string[];
}
/** Progress as the display layer needs it: the stored percentage plus when it was saved. */
export interface StoredProgress { percentage: number; updatedAt: number }
export interface ProgressRepository {
  get(id: string): ReadingProgress | undefined;
  getMany(ids: string[]): Map<string, StoredProgress>;
  save(id: string, progress: ReadingProgress, now: number): void;
  /**
   * Keeps the most recently updated web progress when a duplicate book is merged into the
   * canonical one. `progress` is the duplicate's stored row (for the merge log).
   */
  merge(fromBookId: string, toBookId: string): { kept: boolean; progress: StoredProgress & { position: string } | null };
}
export interface SyncProgressRepository { get(document: string): StoredSyncedProgress | undefined; save(progress: StoredSyncedProgress): void }
export interface Clock { now(): number }
export interface IdGenerator { next(): string }
export interface Extracted { title?: string; author?: string; cover?: { data: Buffer; ext: string } }
export interface MetadataExtractor { extract(path: string): Promise<Extracted> }
export interface FileEntry { name: string; path: string; directory: boolean; file: boolean; symlink: boolean }
export interface FileStore {
  extension(path: string): string;
  title(path: string): string;
  join(...parts: string[]): string;
  resolve(path: string): string;
  realpath(path: string): Promise<string>;
  parent(path: string): string;
  isRoot(path: string): boolean;
  isWindows: boolean;
  home: string;
  isDirectory(path: string): Promise<boolean>;
  accessible(path: string): Promise<boolean>;
  entries(path: string): Promise<FileEntry[]>;
  stat(path: string): Promise<{ size: number; mtime: number }>;
  /**
   * Like `stat`, but returns null only when the path definitively does not exist. Any
   * other failure (permissions, I/O, a network share) is thrown: callers must never
   * mistake an unavailable path for a removed one.
   */
  statIfExists(path: string): Promise<{ size: number; mtime: number } | null>;
  /** Final path a managed upload will get; needed before moving it for content identity. */
  managedPath(id: string, format: string): string;
  moveUpload(tmp: string, id: string, format: string): Promise<string>;
  writeCover(id: string, cover: NonNullable<Extracted["cover"]>): Promise<string>;
  remove(path: string): Promise<void>;
  /**
   * Removes a file only when its canonical path is inside the app-managed directories
   * (uploads or covers). Library-folder files, traversal and symlinks that resolve outside
   * are never touched. Returns whether the path was removed.
   */
  removeManaged(path: string): Promise<boolean>;
}
export interface Logger {
  info(message: string): void;
  error(error: unknown, message: string): void;
  /** Optional so lightweight test loggers stay valid; adapters use it for non-fatal failures. */
  warn?(message: string): void;
}
