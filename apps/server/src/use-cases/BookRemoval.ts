import { ConflictError } from "../domain/errors.js";
import type { Book } from "../domain/library/Book.js";
import { fileView } from "../domain/library/Book.js";
import type { IgnoredBook } from "../domain/library/IgnoredBook.js";
import type {
  BookListReader,
  BookSelection,
  Clock,
  DuplicateRepository,
  FileStore,
  IdGenerator,
  IgnoredBookRepository,
  Logger,
  NoteRepository,
  UnitOfWork,
} from "../ports/index.js";
import type { ConversationRepository } from "../ports/assistant.js";
import { BULK_LIMITS } from "../ports/library-tags.js";
import { BookLocks } from "./BookLocks.js";
import { resolveSelection } from "./BulkSelection.js";

export interface RemovalDryRun {
  books: number;
  notes: number;
  conversations: number;
  withProgress: number;
  indexed: number;
  managedFiles: number;
  externalBooks: number;
  wouldIgnore: number;
}

export interface RemovalResult {
  removed: number;
  missing: number;
  notesRemoved: number;
  ignored: number;
  filesRemoved: number;
  fileErrors: number;
  remaining: number;
}

export interface RemovalOptions {
  confirmNotes?: boolean;
  dryRun?: boolean;
}

/** Block size per transaction (ADR-7); yields to the event loop between blocks. */
const DELETE_BLOCK = 100;

/** Ceiling for the ids echoed by a partial-failure 409 (ADR-7 contract). */
const MAX_REMAINING_IDS = 1000;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const isUpload = (book: Book): boolean => book.source_id === null;

/**
 * Deletion with tombstones (ADR-3/ADR-4). The database change is atomic per block and runs
 * before any file operation: a library-folder file is never touched, a managed upload is
 * removed only after its row committed, and a failing file operation never restores data.
 * A note written while the batch runs aborts the remaining blocks; the blocks already
 * committed are cleaned up (files and covers) before the 409 reports what is left.
 */
export class BookRemoval {
  constructor(
    private readonly books: BookRepositoryLike,
    private readonly notes: Pick<NoteRepository, "deleteForBook" | "countForBooks">,
    private readonly conversations: Pick<ConversationRepository, "deleteForBook">,
    private readonly ignored: IgnoredBookRepository,
    private readonly duplicates: Pick<DuplicateRepository, "aliasesForBook" | "statsForBooks">,
    private readonly listReader: Pick<BookListReader, "byIds" | "count" | "matchingIds">,
    private readonly unitOfWork: UnitOfWork,
    private readonly files: Pick<FileStore, "removeManaged" | "statIfExists">,
    private readonly coverThumbs: { invalidate(id: string): Promise<void> },
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly log: Logger,
    private readonly locks: BookLocks = new BookLocks(),
  ) {}

  async removeOne(id: string, options: RemovalOptions = {}): Promise<RemovalResult | undefined> {
    // The lock spans the row deletion and the file cleanup: a concurrent cover edit of the
    // same book must either finish before the snapshot or wait until the book is gone.
    return this.locks.run(id, async () => {
      const book = this.books.get(id);
      if (!book) return undefined;
      const reviewedNotes = new Map<string, number>();
      const report = this.report([book], reviewedNotes);
      this.assertNotesConfirmed(report.notes, options);
      return this.execute([book], 0, options, { ids: [id] }, reviewedNotes);
    });
  }

  async remove(selection: BookSelection, options: RemovalOptions = {}): Promise<RemovalDryRun | RemovalResult> {
    const resolved = resolveSelection(selection, this.listReader, {
      maxIds: BULK_LIMITS.maxDeleteSelectionIds,
      maxFilter: BULK_LIMITS.maxFilterSelection,
    });
    if (options.dryRun === true) {
      return this.report(this.listReader.byIds(resolved.ids), new Map<string, number>());
    }
    return this.locks.run(resolved.ids, async () => {
      const books = this.listReader.byIds(resolved.ids);
      // Snapshot of the reviewed impact per book: a later mismatch means the user confirmed a
      // different set of notes, so the operation must stop before deleting it.
      const reviewedNotes = new Map<string, number>();
      const report = this.report(books, reviewedNotes);
      this.assertNotesConfirmed(report.notes, options);
      const result = await this.execute(books, resolved.missing, options, selection, reviewedNotes);
      // Re-counted after the operation: a filter selection is idempotent and reports what is
      // still left (0 unless the result set changed mid-way and could not be processed).
      return "filter" in selection
        ? { ...result, remaining: this.listReader.count(selection.filter) }
        : result;
    });
  }

  private assertNotesConfirmed(notes: number, options: RemovalOptions): void {
    if (notes > 0 && options.confirmNotes !== true) {
      throw new ConflictError(
        "This selection has notes; confirm their deletion to continue",
        "notes_confirmation_required",
        { notes },
      );
    }
  }

  private report(books: Book[], reviewedNotes?: Map<string, number>): RemovalDryRun {
    const stats = this.duplicates.statsForBooks(books.map((book) => book.id));
    const report: RemovalDryRun = {
      books: books.length,
      notes: 0,
      conversations: 0,
      withProgress: 0,
      indexed: 0,
      managedFiles: 0,
      externalBooks: 0,
      wouldIgnore: 0,
    };
    for (const book of books) {
      const entry = stats.get(book.id);
      reviewedNotes?.set(book.id, entry?.notes ?? 0);
      if (entry) {
        report.notes += entry.notes;
        report.conversations += entry.conversations;
        if (entry.hasProgress) report.withProgress += 1;
        if (entry.indexState !== "none") report.indexed += 1;
      }
      if (isUpload(book)) report.managedFiles += 1;
      else report.externalBooks += 1;
      report.wouldIgnore += this.ignoredEntriesFor(book).length;
    }
    return report;
  }

  /**
   * The tombstone list for one deleted book. Library folders are never written to, so the
   * canonical path is remembered even when no hash was ever computed. An upload has no path
   * that a scan would find; it only needs a content tombstone when a copy still exists in a
   * library folder (an alias), otherwise nothing could re-import it.
   */
  private ignoredEntriesFor(book: Book): Array<Omit<IgnoredBook, "id" | "ignoredAt">> {
    const aliases = this.duplicates.aliasesForBook(book.id);
    const contentHash = book.content_hash ?? aliases[0]?.contentHash ?? null;
    const base = {
      sourceId: book.source_id,
      contentHash,
      size: book.size,
      title: book.title,
      author: book.author,
      format: book.format,
      managed: isUpload(book),
    };
    if (!isUpload(book)) {
      // One row simultaneously covers the exact path and the content (aliases, new copies).
      return [{ ...base, path: book.path }];
    }
    if (aliases.length === 0 || contentHash === null) return [];
    return [{ ...base, path: null }];
  }

  private async execute(
    books: Book[],
    missing: number,
    options: RemovalOptions,
    selection: BookSelection,
    reviewedNotes: ReadonlyMap<string, number>,
  ): Promise<RemovalResult> {
    const now = this.clock.now();
    let removed = 0;
    let ignored = 0;
    let notesRemoved = 0;
    let start = 0;
    try {
      for (; start < books.length; start += DELETE_BLOCK) {
        const block = books.slice(start, start + DELETE_BLOCK);
        this.unitOfWork.run(() => {
          // A note can be written between blocks (the loop yields to the event loop) or
          // between the dry-run count and the first block. Re-check inside the transaction,
          // immediately before deleting, so an unconfirmed note is never discarded — even
          // when the user had already confirmed the notes seen at review.
          const blockNotes = this.notes.countForBooks(block.map((book) => book.id));
          this.assertNotesConfirmed(blockNotes, options);
          const reviewed = block.reduce((sum, book) => sum + (reviewedNotes.get(book.id) ?? 0), 0);
          if (blockNotes !== reviewed) {
            // Internal marker: execute() reports it as `selection_changed` with the progress.
            throw new ConflictError("The confirmed notes changed", "notes_confirmation_required");
          }
          const tombstones: IgnoredBook[] = [];
          for (const book of block) {
            for (const entry of this.ignoredEntriesFor(book)) {
              tombstones.push({ ...entry, id: this.ids.next(), ignoredAt: now });
            }
          }
          // Tombstones and the deletion commit together, so a scan never sees the book gone
          // without the entry that prevents it from being imported again.
          ignored += this.ignored.saveMany(tombstones);
          for (const book of block) {
            this.notes.deleteForBook(book.id);
            this.conversations.deleteForBook(book.id);
          }
          this.books.deleteMany(block.map((book) => book.id));
          notesRemoved += blockNotes;
        });
        removed += block.length;
        if (start + DELETE_BLOCK < books.length) await yieldToLoop();
      }
    } catch (error) {
      // Every block before `start` is committed. Clean their managed files and covers now,
      // before answering, so a partial deletion never leaves an orphan behind.
      await this.removeManagedFiles(books.slice(0, start));
      if (error instanceof ConflictError && error.code === "notes_confirmation_required") {
        throw this.selectionChanged(selection, books, start, removed);
      }
      throw error;
    }

    const files = await this.removeManagedFiles(books);
    return {
      removed,
      missing,
      notesRemoved,
      ignored,
      filesRemoved: files.removed,
      fileErrors: files.errors,
      remaining: 0,
    };
  }

  /**
   * A note written after the caller reviewed the impact invalidates the confirmation. The
   * caller gets the ids still pending (or the remaining total for a filter selection) so it
   * can show the partial result and retry just what is left.
   */
  private selectionChanged(
    selection: BookSelection,
    books: Book[],
    start: number,
    removed: number,
  ): ConflictError {
    const details: Record<string, unknown> = { removed };
    if ("ids" in selection) {
      const remaining = books.slice(start).map((book) => book.id);
      details.remainingIds = remaining.slice(0, MAX_REMAINING_IDS);
      if (remaining.length > MAX_REMAINING_IDS) details.remainingTotal = remaining.length;
    } else {
      const remainingTotal = this.listReader.count(selection.filter);
      details.remainingTotal = remainingTotal;
      if (remainingTotal <= MAX_REMAINING_IDS) {
        details.remainingIds = this.listReader.matchingIds(selection.filter, MAX_REMAINING_IDS);
      }
    }
    return new ConflictError(
      "The selection changed while the deletion was running; review the remaining books and confirm again",
      "selection_changed",
      details,
    );
  }

  /** Best effort, only after every block committed; library-folder files are never passed. */
  private async removeManagedFiles(books: Book[]): Promise<{ removed: number; errors: number }> {
    let removed = 0;
    let errors = 0;
    for (const book of books) {
      if (isUpload(book)) {
        try {
          if (await this.files.removeManaged(book.path)) removed += 1;
        } catch (error) {
          errors += 1;
          this.log.warn?.(`cannot remove managed book file ${book.path}: ${(error as Error).message}`);
        }
      }
      // A custom cover and the file-extracted cover can both exist: the effective path
      // wins for display, while the file snapshot still leaves a managed file behind.
      const covers = [book.cover_path, fileView(book).cover_path].filter((path): path is string => path !== null);
      for (const path of new Set(covers)) {
        try {
          if (await this.files.removeManaged(path)) removed += 1;
        } catch (error) {
          errors += 1;
          this.log.warn?.(`cannot remove cover ${path}: ${(error as Error).message}`);
        }
      }
      try {
        await this.coverThumbs.invalidate(book.id);
      } catch (error) {
        errors += 1;
        this.log.warn?.(`cannot invalidate thumbnail ${book.id}: ${(error as Error).message}`);
      }
    }
    return { removed, errors };
  }
}

interface BookRepositoryLike {
  get(id: string): Book | undefined;
  deleteMany(ids: string[]): void;
}
