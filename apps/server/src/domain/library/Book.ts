import { createHash } from "node:crypto";
export interface Book {
  id: string;
  title: string;
  author: string;
  format: "pdf" | "epub";
  path: string;
  cover_path: string | null;
  size: number;
  added_at: number;
  source_id: string | null;
  mtime: number | null;
  status: "pending" | "ready" | "error";
  /**
   * Full-file SHA-256. Optional so existing constructors stay valid; `null` means "not
   * computed yet" and is filled lazily only when another book shares the same size.
   */
  content_hash?: string | null;
  /** SQLite boolean flag; the DTO exposes it as `favorite`. Optional for existing constructors. */
  favorite?: 0 | 1;
  /** File-side snapshot kept when the user overrides title/author/cover (ADR-2). */
  file_title?: string | null;
  file_author?: string | null;
  file_cover_path?: string | null;
  /** Bumped whenever the custom cover changes; null when the cover still comes from the file. */
  cover_rev?: number | null;
}


export const supportedFormat = (extension: string): extension is Book["format"] => extension === "pdf" || extension === "epub";

/**
 * Projects a row back to the values extracted from the file, ignoring any user override.
 * Repositories accept file values on write while `get`/`list` return effective values
 * (ADR-2), so callers that start from `books.get()` must pass it through this helper;
 * otherwise a rescan would promote the override to be the new file value.
 */
export const fileView = (book: Book): Book => ({
  ...book,
  title: book.file_title ?? book.title,
  author: book.file_author ?? book.author,
  cover_path: book.file_cover_path ?? book.cover_path,
});

export const sourceBookId = (path: string): string => createHash("sha1").update(path).digest("hex").slice(0, 32);
