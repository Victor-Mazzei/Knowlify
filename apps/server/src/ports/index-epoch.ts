/**
 * Monotonic, in-process counter of every write that changes the passage index or the
 * eligibility of a book for retrieval: chunk/vector rows and `book_index` state or
 * `index_version` transitions.
 *
 * Retrieval caches capture the epoch before a read and compare it after the read:
 * a write that lands in between can never be stored as fresh, and any observed
 * change invalidates the whole cache. The vector sample offset also derives from this
 * value, so a change that alters the eligible book list rotates the sample together
 * with the invalidation. It is intentionally not persisted: the cache is process-local
 * too, so both restart empty.
 */
export interface IndexEpoch {
  /** Current value; starts at zero and only grows. */
  current(): number;
  /** Records that the index changed. Called after the write committed. */
  bump(): void;
}
