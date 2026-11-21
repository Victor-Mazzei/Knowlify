import { NotFoundError } from "../domain/errors.js";
import type { BookRepository, ProgressRepository, SyncProgressRepository, ReadingProgress, StoredProgress, Clock } from "../ports/index.js";
import type { SyncedProgress } from "../domain/reading/ReadingProgress.js";
export class Progress {
  constructor(private progress: ProgressRepository, private books: BookRepository, private clock: Clock) {}
  get(id: string) { return this.progress.get(id); }
  forBooks(ids: string[]): Map<string, StoredProgress> { return this.progress.getMany(ids); }
  save(id: string, progress: ReadingProgress): void {
    if (!this.books.get(id)) throw new NotFoundError("Not found");
    this.progress.save(id, progress, this.clock.now());
  }
}
export class SyncProgress {
  constructor(private progress: SyncProgressRepository, private clock: Clock) {}
  get(document: string) { return this.progress.get(document); }
  save(progress: SyncedProgress) {
    const timestamp = Math.floor(this.clock.now() / 1000);
    this.progress.save({ ...progress, timestamp });
    return { document: progress.document, timestamp };
  }
}
