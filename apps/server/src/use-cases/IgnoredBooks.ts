import { ValidationError } from "../domain/errors.js";
import { ignoredReason, type IgnoredBook } from "../domain/library/IgnoredBook.js";
import type { IgnoredBookRepository } from "../ports/library-ignore.js";
import type { IndexEpoch } from "../ports/index-epoch.js";

export interface IgnoredBookDto {
  id: string;
  title: string;
  author: string;
  format: IgnoredBook["format"];
  size: number;
  path: string | null;
  sourceId: string | null;
  reason: ReturnType<typeof ignoredReason>;
  managed: boolean;
  ignoredAt: number;
}

export const toIgnoredBookDto = (book: IgnoredBook): IgnoredBookDto => ({
  id: book.id,
  title: book.title,
  author: book.author,
  format: book.format,
  size: book.size,
  path: book.path,
  sourceId: book.sourceId,
  reason: ignoredReason(book),
  managed: book.managed,
  ignoredAt: book.ignoredAt,
});

const MAX_RESTORE_IDS = 100;

/**
 * Restoring drops the tombstones and asks the scanner to walk the sources again. The book
 * comes back as a new entry: notes, progress and index were deleted with the old row
 * (product decision, documented in SYSTEM_DESIGN).
 */
export class IgnoredBooks {
  constructor(
    private readonly ignored: IgnoredBookRepository,
    private readonly startScan: () => void,
    private readonly epoch?: IndexEpoch,
  ) {}

  list(limit: number, offset: number): { items: IgnoredBookDto[]; total: number } {
    return {
      items: this.ignored.list(limit, offset).map(toIgnoredBookDto),
      total: this.ignored.count(),
    };
  }

  restore(ids: string[]): { restored: number; scanStarted: boolean } {
    if (ids.length === 0) throw new ValidationError("ids cannot be empty");
    if (ids.length > MAX_RESTORE_IDS) throw new ValidationError(`ids accepts at most ${MAX_RESTORE_IDS} values`);
    const restored = this.ignored.deleteMany([...new Set(ids)]);
    this.startScan();
    // A restored tombstone never restores the old index row; the scan re-adds the book and
    // ingestion will fill it. Bumping now also covers the window before that happens.
    this.epoch?.bump();
    return { restored, scanStarted: true };
  }
}
