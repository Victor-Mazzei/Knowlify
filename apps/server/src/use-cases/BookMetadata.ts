import { maxMetadataYear, MetadataDisabledError, normalizeMetadataPatch, type NormalizedMetadataPatch } from "../domain/library/BookMetadata.js";
import { ValidationError } from "../domain/errors.js";
import type { Book } from "../domain/library/Book.js";
import type { BookRepository, Clock, CoverFetcher, Logger } from "../ports/index.js";
import type {
  BookMetadataDetail,
  BookMetadataRepository,
  CustomCoverStore,
  LookupSwitch,
  MetadataField,
  MetadataOverride,
} from "../ports/library-metadata.js";
import { BookLocks } from "./BookLocks.js";

/** One book plus the metadata object of `GET /api/books/:id`. */
export interface DetailedBook {
  book: Book;
  metadata: BookMetadataDetail;
}

export interface BookMetadataOptions {
  /** Wired in production; absent in unit tests that never fetch a cover by URL. */
  coverFetcher?: CoverFetcher;
  /** `KNOWLIFY_METADATA_LOOKUP` (or the saved user value); URL covers follow the switch. */
  lookupEnabled?: LookupSwitch;
  log?: Logger;
}

const FIELDS: readonly MetadataField[] = [
  "title", "author", "description", "isbn10", "isbn13", "year",
  "publisher", "language", "series", "cover",
];

const emptyOverride = (bookId: string, now: number): MetadataOverride => ({
  bookId,
  title: null,
  author: null,
  description: null,
  isbn10: null,
  isbn13: null,
  year: null,
  publisher: null,
  language: null,
  series: null,
  seriesIndex: null,
  coverPath: null,
  source: "manual",
  updatedAt: now,
});

function mergeOverride(
  current: MetadataOverride | null,
  patch: NormalizedMetadataPatch,
  bookId: string,
  now: number,
): MetadataOverride {
  const next = current ? { ...current } : emptyOverride(bookId, now);
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.author !== undefined) next.author = patch.author;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.isbn10 !== undefined) next.isbn10 = patch.isbn10;
  if (patch.isbn13 !== undefined) next.isbn13 = patch.isbn13;
  if (patch.year !== undefined) next.year = patch.year;
  if (patch.publisher !== undefined) next.publisher = patch.publisher;
  if (patch.language !== undefined) next.language = patch.language;
  if (patch.series !== undefined) next.series = patch.series;
  if (patch.seriesIndex !== undefined) next.seriesIndex = patch.seriesIndex;
  // Clearing the series also clears its ranking; setting a ranking without a series fails.
  if (next.series === null && next.seriesIndex !== null) {
    if (patch.seriesIndex !== undefined && patch.seriesIndex !== null) {
      throw new ValidationError("seriesIndex requires a series", undefined, { field: "seriesIndex" });
    }
    next.seriesIndex = null;
  }
  next.source = patch.source ?? "manual";
  next.updatedAt = now;
  return next;
}

/**
 * Application rules for `GET /api/books/:id` metadata and its edits (ADR-2). The
 * repository materializes the effective title/author/cover; this use case never writes
 * `books` directly and never touches a library folder.
 */
export class BookMetadata {
  constructor(
    private readonly books: Pick<BookRepository, "get">,
    private readonly repository: BookMetadataRepository,
    private readonly covers: CustomCoverStore,
    private readonly coverThumbs: { invalidate(id: string): Promise<void> },
    private readonly clock: Clock,
    private readonly options: BookMetadataOptions = {},
    private readonly locks: BookLocks = new BookLocks(),
  ) {}

  detail(bookId: string): DetailedBook | null {
    const book = this.books.get(bookId);
    if (!book) return null;
    return { book, metadata: this.detailOf(book, this.repository.get(bookId)) };
  }

  patch(bookId: string, raw: unknown): DetailedBook | null {
    const book = this.books.get(bookId);
    if (!book) return null;
    const now = this.clock.now();
    const patch = normalizeMetadataPatch(raw, maxMetadataYear(now));
    const merged = mergeOverride(this.repository.get(bookId), patch, bookId, now);
    if (!this.repository.save(merged)) return null;
    return this.detail(bookId);
  }

  async reset(bookId: string): Promise<DetailedBook | null> {
    return this.locks.run(bookId, () => this.applyReset(bookId));
  }

  async clearCover(bookId: string): Promise<DetailedBook | null> {
    return this.locks.run(bookId, () => this.applyClearCover(bookId));
  }

  async setCover(bookId: string, data: Buffer): Promise<DetailedBook | null> {
    return this.locks.run(bookId, () => this.storeCover(bookId, data));
  }

  private async applyReset(bookId: string): Promise<DetailedBook | null> {
    const book = this.books.get(bookId);
    if (!book) return null;
    const override = this.repository.get(bookId);
    if (!this.repository.reset(bookId)) return null;
    if (override?.coverPath) await this.removeCoverFile(bookId);
    await this.invalidateThumb(bookId);
    return this.detail(bookId);
  }

  private async applyClearCover(bookId: string): Promise<DetailedBook | null> {
    const book = this.books.get(bookId);
    if (!book) return null;
    const override = this.repository.get(bookId);
    if (!this.repository.setCover(bookId, null, null, this.clock.now())) return null;
    if (override?.coverPath) await this.removeCoverFile(bookId);
    await this.invalidateThumb(bookId);
    return this.detail(bookId);
  }

  private async storeCover(bookId: string, data: Buffer): Promise<DetailedBook | null> {
    const book = this.books.get(bookId);
    if (!book) return null;
    // Validation happens before anything is overwritten: a malformed image never
    // replaces a working cover.
    const path = await this.covers.save(bookId, data);
    // Strictly newer than the previous revision, even for two edits in the same ms:
    // the web `?v=` must always bust the 24 h cover cache.
    const revision = Math.max(this.clock.now(), (book.cover_rev ?? 0) + 1);
    if (!this.repository.setCover(bookId, path, revision, this.clock.now())) {
      await this.covers.remove(bookId);
      return null;
    }
    await this.invalidateThumb(bookId);
    return this.detail(bookId);
  }

  async setCoverFromUrl(bookId: string, rawUrl: unknown): Promise<DetailedBook | null> {
    if (!this.lookupEnabled()) throw new MetadataDisabledError();
    if (!this.books.get(bookId)) return null;
    const url = coverUrl(rawUrl);
    if (!this.options.coverFetcher) throw new Error("Cover download is not configured");
    const data = await this.options.coverFetcher.fetch(url, AbortSignal.timeout(10_000));
    return this.setCover(bookId, data);
  }

  private lookupEnabled(): boolean {
    const value = this.options.lookupEnabled;
    return typeof value === "function" ? value() : value === true;
  }

  private detailOf(book: Book, override: MetadataOverride | null): BookMetadataDetail {
    const overridden = Object.fromEntries(FIELDS.map((field) => [field, false])) as Record<MetadataField, boolean>;
    if (override) {
      overridden.title = override.title !== null;
      overridden.author = override.author !== null;
      overridden.description = override.description !== null;
      overridden.isbn10 = override.isbn10 !== null;
      overridden.isbn13 = override.isbn13 !== null;
      overridden.year = override.year !== null;
      overridden.publisher = override.publisher !== null;
      overridden.language = override.language !== null;
      overridden.series = override.series !== null;
      overridden.cover = override.coverPath !== null;
    }
    return {
      title: book.title,
      author: book.author,
      description: override?.description ?? null,
      isbn10: override?.isbn10 ?? null,
      isbn13: override?.isbn13 ?? null,
      year: override?.year ?? null,
      publisher: override?.publisher ?? null,
      language: override?.language ?? null,
      series: override?.series ?? null,
      seriesIndex: override?.seriesIndex ?? null,
      file: {
        title: book.file_title ?? book.title,
        author: book.file_author ?? book.author,
      },
      overridden,
      source: override?.source ?? null,
      updatedAt: override?.updatedAt ?? null,
    };
  }

  private async removeCoverFile(bookId: string): Promise<void> {
    try {
      await this.covers.remove(bookId);
    } catch (error) {
      this.options.log?.error(error, `cannot remove custom cover ${bookId}`);
    }
  }

  private async invalidateThumb(bookId: string): Promise<void> {
    try {
      await this.coverThumbs.invalidate(bookId);
    } catch (error) {
      this.options.log?.error(error, `cannot invalidate thumbnail ${bookId}`);
    }
  }
}

function coverUrl(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("Invalid cover request", undefined, { field: "body" });
  }
  const value = (raw as Record<string, unknown>).url;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_048) {
    throw new ValidationError("url must be a non-empty HTTPS URL", undefined, { field: "url" });
  }
  return value.trim();
}
