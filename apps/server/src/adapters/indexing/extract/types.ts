import type { TextSection } from "../../../domain/knowledge/BookIndex.js";

export interface ExtractOptions {
  /** Called with a fraction in [0, 1] as extraction advances. */
  onProgress?: (fraction: number) => void;
}

/**
 * Streams the readable text of a book, one page or chapter at a time. File
 * handles are opened read-only: books in external folders are never modified.
 */
export interface TextExtractor {
  extract(path: string, options?: ExtractOptions): AsyncIterable<TextSection>;
}
