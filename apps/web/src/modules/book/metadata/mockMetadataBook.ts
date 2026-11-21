import type { Book } from "../../../types";
import type { BookDetail, BookMetadata, MetadataField } from "../types";

const FIELDS: MetadataField[] = [
  "title",
  "author",
  "description",
  "isbn10",
  "isbn13",
  "year",
  "publisher",
  "language",
  "series",
  "cover",
];

export const noOverrides = (): Record<MetadataField, boolean> =>
  Object.fromEntries(FIELDS.map((field) => [field, false])) as Record<MetadataField, boolean>;

/**
 * A coherent detail for stories and tests: the manual form starts from the effective
 * values and the file keeps only title/author, like the server contract.
 */
export function sampleBookDetail(book: Partial<Book> = {}, metadata: Partial<BookMetadata> = {}): BookDetail {
  const base: BookDetail = {
    id: "meta-1",
    title: "The Quiet Library",
    author: "Ada North",
    format: "epub",
    size: 1_400_000,
    addedAt: 1_760_000_000_000,
    hasCover: true,
    status: "ready",
    source: true,
    index: { state: "ready", error: null },
    progress: null,
    tagIds: [],
    favorite: false,
    coverRev: null,
    metadata: {
      title: "The Quiet Library",
      author: "Ada North",
      description: null,
      isbn10: null,
      isbn13: null,
      year: null,
      publisher: null,
      language: null,
      series: null,
      seriesIndex: null,
      file: { title: "The Quiet Library", author: "Ada North" },
      overridden: noOverrides(),
      source: null,
      updatedAt: null,
    },
  };
  const mergedMetadata: BookMetadata = {
    ...base.metadata,
    ...metadata,
    file: { ...base.metadata.file, ...metadata.file },
    overridden: { ...base.metadata.overridden, ...metadata.overridden },
  };
  return {
    ...base,
    ...book,
    title: book.title ?? mergedMetadata.title,
    author: book.author ?? mergedMetadata.author,
    metadata: mergedMetadata,
  };
}
