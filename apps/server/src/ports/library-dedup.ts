import type { Book } from "../domain/library/Book.js";

/** Full-file SHA-256 (lowercase hex). */
export interface ContentHasher {
  hash(path: string): Promise<string>;
}

/** One alternate path that points at an existing book instead of becoming a new row. */
export interface DuplicateAlias {
  path: string;
  bookId: string;
  sourceId: string | null;
  size: number;
  mtime: number | null;
  contentHash: string;
  detectedAt: number;
}

export type AliasSnapshot = Omit<DuplicateAlias, "detectedAt">;

export interface DuplicateSizeGroup {
  size: number;
  count: number;
}

export interface DuplicateContentGroup {
  size: number;
  contentHash: string;
}

export interface DuplicateContentAnchor {
  size: number;
  contentHash: string;
}

export interface DuplicateContentCounts {
  groups: number;
  redundantBooks: number;
}

/** User data that decides which copy of a duplicate group is kept (ADR-7). */
export interface DuplicateBookStats {
  notes: number;
  conversations: number;
  hasProgress: boolean;
  progressUpdatedAt: number | null;
  indexState: "none" | "pending" | "indexing" | "ready" | "error";
}

export interface DuplicateRepository {
  aliasSnapshotForSource(sourceId: string): Map<string, AliasSnapshot>;
  /** Oldest first, so promotion is deterministic across scans. */
  aliasesForBook(bookId: string): AliasSnapshot[];
  upsertAlias(alias: DuplicateAlias): void;
  deleteAlias(path: string): void;
  deleteAliasesForBook(bookId: string): void;
  deleteAliasesForSource(sourceId: string): void;
  /**
   * Moves the book row to an alias path in one transaction, keeping its id (and with it
   * notes, progress and index). Returns false when the alias vanished or its path is
   * already owned by another book.
   */
  promoteAlias(bookId: string, path: string): boolean;
  /** Sizes shared by more than one book, ordered by size. */
  sizeGroups(): DuplicateSizeGroup[];
  /** Content groups after `after` (size DESC, contentHash ASC), used by the paginated API. */
  contentGroups(after: DuplicateContentAnchor | null, limit: number): DuplicateContentGroup[];
  contentGroupCounts(): DuplicateContentCounts;
  /** Every book that shares its content with at least one other book (summary estimate). */
  redundantBookIds(): string[];
  statsForBooks(bookIds: string[]): Map<string, DuplicateBookStats>;
  aliasesForBooks(bookIds: string[]): Map<string, string[]>;
  /** Approximate bytes freed by discarding the index of the given books. */
  reclaimableBytes(bookIds: string[]): number;
}

export interface MergeLogEntry {
  id: string;
  canonicalId: string;
  duplicateId: string;
  duplicatePath: string;
  sourceId: string | null;
  contentHash: string;
  noteIds: string[];
  progress: { position: string; percentage: number; updatedAt: number } | null;
  mergedAt: number;
}

export interface MergeLogRepository {
  save(entry: MergeLogEntry): void;
  /** Retention: entries older than `before` are dropped at boot (undo is phase 2). */
  prune(before: number): number;
}

/** Wraps synchronous repository calls in one SQLite transaction. */
export interface UnitOfWork {
  run<T>(fn: () => T): T;
}

/** What one completed source walk of the current scan execution observed. */
export interface ScanEvidence {
  /** Files whose stat succeeded during the walk. */
  readonly seen: ReadonlySet<string>;
  /** Directories the walk could not read. */
  readonly unreadable: readonly string[];
  /** Files whose stat failed during the walk. */
  readonly failedStat: ReadonlySet<string>;
}

export interface IdentityRequest {
  /**
   * Provisional row for the file being resolved. `book.path` is the final path (managed
   * upload path or source path) and `book.id` is the id to use when the file is new.
   */
  book: Book;
  /** Set when `book.path` already belongs to a book whose file changed on disk. */
  existingBookId?: string;
  /** Hash already computed by the upload stream; avoids reading the file again. */
  contentHash?: string;
  /**
   * Read the bytes even when no candidate shares the size. The scanner sets it when an
   * ignored tombstone has the same size, because only the hash can prove the content was
   * deleted before.
   */
  forceHash?: boolean;
  /**
   * An explicit upload may restore ignored content (ADR-4): the tombstone check is skipped
   * during resolution and the caller removes the entries only after the import succeeds,
   * so a failed import leaves the ignored entry in place.
   */
  restoreIgnored?: boolean;
  /**
   * Completed walks of the current scan execution, keyed by source id. A source missing
   * from this map was not successfully scanned, so a missing file under it is never proof
   * that the book moved. Uploads resolve outside a scan and therefore pass no evidence.
   */
  scan?: ReadonlyMap<string, ScanEvidence>;
}

export type ContentIdentityOutcome =
  | { kind: "new"; book: Book }
  | { kind: "changed"; book: Book }
  | { kind: "duplicate"; bookId: string }
  | { kind: "moved"; bookId: string; book: Book }
  /** The content belongs to a deleted book and must not be imported again (ADR-4). */
  | { kind: "ignored" };

export interface ContentIdentityResolver {
  resolve(request: IdentityRequest): Promise<ContentIdentityOutcome>;
}
