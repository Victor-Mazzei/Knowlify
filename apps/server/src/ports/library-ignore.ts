import type { IgnoredBook } from "../domain/library/IgnoredBook.js";

/**
 * Books the user deleted (ADR-4). The scanner consults it at flush time and
 * `ContentIdentity` after hashing, so a deletion that races a scan is still respected.
 */
export interface IgnoredBookRepository {
  /** One transaction; repeated paths are ignored (the unique path index decides). */
  saveMany(books: IgnoredBook[]): number;
  /** Paths among `paths` that are ignored, in one IN list per 500 entries. */
  pathsAmong(paths: string[]): Set<string>;
  sizesAmong(sizes: number[]): Set<number>;
  hasHash(contentHash: string): boolean;
  /** Drops every entry that describes this content (upload restore). Returns rows removed. */
  removeByHash(contentHash: string): number;
  deleteMany(ids: string[]): number;
  byIds(ids: string[]): IgnoredBook[];
  /** Newest first, for the Settings list. */
  list(limit: number, offset: number): IgnoredBook[];
  count(): number;
}
