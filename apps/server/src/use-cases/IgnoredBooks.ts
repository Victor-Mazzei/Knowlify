import { ValidationError } from "../domain/errors.js";
import { ignoredReason, type IgnoredBook } from "../domain/library/IgnoredBook.js";
import type { IgnoredBookRepository } from "../ports/library-ignore.js";

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
    return { restored, scanStarted: true };
  }
}
