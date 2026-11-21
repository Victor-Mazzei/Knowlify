/**
 * In-process mutex per book. A metadata edit commits the database row and then touches
 * the custom cover file; those two steps cannot be atomic together, so without
 * serialization a clear/reset waiting for the file removal can delete the file a
 * concurrent set just saved while the database still points at it.
 *
 * The lock covers the whole operation, not an individual database or file call. Merges
 * and deletions of the same books use the same lock through `run` with several ids.
 *
 * The server runs as a single Node process (local-first deployment); coordinating
 * writers across processes would need a database or filesystem lock and is out of scope.
 */
export class BookLocks {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Runs `work` after every previously queued operation on the same books. Multiple ids
   * are acquired in sorted order, so two multi-book operations (duplicate merge, bulk
   * deletion) always request them in the same order and cannot deadlock.
   */
  async run<T>(bookIds: string | readonly string[], work: () => Promise<T>): Promise<T> {
    const ids = [...new Set(typeof bookIds === "string" ? [bookIds] : bookIds)].sort();
    const releases: Array<() => void> = [];
    try {
      for (const id of ids) releases.push(await this.acquire(id));
      return await work();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async acquire(id: string): Promise<() => void> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(id, tail);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseHeld();
      // A later waiter may already own the tail; only the last one clears the key.
      if (this.tails.get(id) === tail) this.tails.delete(id);
    };
  }
}
