import { fileView, supportedFormat } from "../domain/library/Book.js";
import { ConflictError, ValidationError } from "../domain/errors.js";
import type {
  Book,
  BookFacets,
  BookListFilter,
  BookListQuery,
  BookListReader,
  BookPage,
  BookRepository,
  ContentIdentityResolver,
  IgnoredBookRepository,
  NoteRepository,
  FileStore,
  Clock,
  IdGenerator,
  MetadataExtractor,
  Extracted,
  TagRepository,
} from "../ports/index.js";
import type { ConversationRepository } from "../ports/assistant.js";
import type { IndexScheduler } from "../ports/knowledge.js";

/** Result of an upload; `duplicate` selects the 200 + `duplicateOf` response. */
export interface ImportResult {
  book: Book;
  duplicate: boolean;
  /** The upload matched an ignored tombstone; the import un-ignored it (ADR-4). */
  restoredFromIgnored: boolean;
}

/** Size and hash computed while the request body was streamed to the temp file. */
export interface UploadIdentity {
  size: number;
  contentHash: string;
}

/** Application operations shared by HTTP and the catalog. */
export class Library {
  constructor(private books: BookRepository, private notes: NoteRepository, private files: FileStore,
    private clock: Clock, private ids: IdGenerator, private metadata: Record<Book["format"], MetadataExtractor>,
    private indexer?: IndexScheduler,
    private conversations?: Pick<ConversationRepository, "deleteForBook">,
    private listReader?: BookListReader,
    private identity?: ContentIdentityResolver,
    private ignored?: IgnoredBookRepository,
    private tags?: TagRepository) {}
  async importFile(tmp: string, originalName: string, upload?: UploadIdentity): Promise<ImportResult> {
    const format = this.files.extension(originalName);
    if (!supportedFormat(format)) {
      await this.files.remove(tmp);
      throw new ValidationError("Only PDF and EPUB are supported");
    }
    const id = this.ids.next();
    if (this.identity && upload) {
      // The streamed hash describes exactly the bytes written to the temp file. Confirm the
      // file on disk still has that size before any row or file is created; otherwise the
      // hash could later match a different book and trigger a destructive merge.
      const stored = await this.files.statIfExists(tmp);
      if (!stored || stored.size !== upload.size) {
        await this.files.remove(tmp);
        throw new ValidationError("Upload file changed during transfer");
      }
      const path = this.files.managedPath(id, format);
      const provisional: Book = {
        id,
        title: this.files.title(originalName),
        author: "",
        format,
        path,
        cover_path: null,
        size: upload.size,
        added_at: this.clock.now(),
        source_id: null,
        mtime: null,
        status: "pending",
        content_hash: upload.contentHash,
      };
      // Tombstones are dropped only after the import succeeds: a failure while resolving,
      // moving the file or extracting metadata must leave the ignored content ignored.
      const outcome = await this.identity.resolve({
        book: provisional,
        contentHash: upload.contentHash,
        restoreIgnored: true,
      });
      if (outcome.kind === "duplicate") {
        await this.files.remove(tmp);
        const canonical = this.books.get(outcome.bookId);
        if (!canonical) throw new Error("Duplicate book disappeared");
        const restored = this.ignored?.removeByHash(upload.contentHash) ?? 0;
        return { book: canonical, duplicate: true, restoredFromIgnored: restored > 0 };
      }
      if (outcome.kind === "ignored") {
        // `restoreIgnored` skips the tombstone check; a hit here means the resolver stopped
        // honoring it. Refuse instead of creating a row that a later scan would skip.
        await this.files.remove(tmp);
        throw new ConflictError("This content is marked as ignored");
      }
      // `resolve` inserted a new row or moved an existing one to `path`; the managed file
      // still has to be moved and the metadata extracted. A moved book keeps its old id and
      // is reported as an existing book (200), even though its file is now managed.
      const book = await this.finishImport(tmp, outcome.kind === "moved" ? outcome.bookId : id, id,
        format, originalName, upload, path, outcome.kind === "new");
      const restored = this.ignored?.removeByHash(upload.contentHash) ?? 0;
      return {
        book,
        duplicate: outcome.kind !== "new",
        restoredFromIgnored: restored > 0,
      };
    }
    // Legacy path (no dedup wiring): extract first, then persist as before.
    const path = await this.files.moveUpload(tmp, id, format);
    const meta: Extracted = format === "epub" ? await this.metadata.epub.extract(path).catch(() => ({})) : await this.metadata.pdf.extract(path);
    const cover_path = meta.cover ? await this.files.writeCover(id, meta.cover) : null;
    const stored = await this.files.stat(path);
    const book: Book = { id, title: meta.title || this.files.title(originalName), author: meta.author || "", format, path, cover_path,
      size: stored.size, added_at: this.clock.now(), source_id: null, mtime: stored.mtime, status: "ready",
      ...(upload ? { content_hash: upload.contentHash } : {}) };
    this.books.save(book);
    // Search indexing is a background side effect: the upload response never waits for it.
    this.indexer?.schedule(book, 1);
    return { book, duplicate: false, restoredFromIgnored: false };
  }
  private async finishImport(tmp: string, id: string, fileId: string, format: Book["format"], originalName: string,
    upload: UploadIdentity, expectedPath: string, created: boolean): Promise<Book> {
    let movedPath: string | null = null;
    let coverPath: string | null = null;
    let saved = false;
    try {
      // A moved upload keeps the old book id but moves the temp file to the path chosen for
      // this request, so the row written by `resolve` points at a real file.
      movedPath = await this.files.moveUpload(tmp, fileId, format);
      if (movedPath !== expectedPath) throw new Error("Upload path changed during import");
      const current = this.books.get(id);
      const file = current ? fileView(current) : null;
      const meta: Extracted = format === "epub"
        ? await this.metadata.epub.extract(movedPath).catch(() => ({}))
        : await this.metadata.pdf.extract(movedPath);
      coverPath = meta.cover ? await this.files.writeCover(id, meta.cover) : file?.cover_path ?? null;
      // Confirm the moved file still has the size that was hashed while streaming. If it
      // cannot be confirmed, keep the book (notes/progress are never lost) but do not claim
      // the streamed hash: a wrong hash could later justify a destructive merge.
      const stored = await this.files.statIfExists(movedPath).catch(() => null);
      const trusted = stored !== null && stored.size === upload.size;
      const book: Book = {
        id,
        title: meta.title || file?.title || this.files.title(originalName),
        author: meta.author || file?.author || "",
        format,
        path: movedPath,
        cover_path: coverPath,
        size: stored?.size ?? upload.size,
        added_at: current?.added_at ?? this.clock.now(),
        source_id: null,
        mtime: stored?.mtime ?? null,
        status: trusted ? "ready" : "error",
        content_hash: trusted ? upload.contentHash : null,
      };
      this.books.save(book);
      saved = true;
      // A moved book keeps its complete index: the bytes are the same, only the path changed.
      if (created && trusted) this.indexer?.schedule(book, 1);
      // The repository stores file values but reads back effective ones; the response must
      // show what every other consumer sees (an inherited override may apply here).
      return this.books.get(id) ?? book;
    } catch (error) {
      // `resolve` already committed the provisional row (status pending) before the file was
      // moved. A later failure must not leave a phantom book or an orphan managed file; the
      // tombstone is intentionally untouched, so the content stays ignored.
      if (!saved) await this.discardPartialImport(id, expectedPath, movedPath, coverPath, created);
      throw error;
    }
  }

  /** Best effort: the import error is what the caller must see. Rows of existing books stay. */
  private async discardPartialImport(id: string, expectedPath: string, movedPath: string | null,
    coverPath: string | null, created: boolean): Promise<void> {
    if (!created) return;
    this.books.deleteMany([id]);
    const paths = new Set([expectedPath, ...(movedPath === null ? [] : [movedPath]),
      ...(coverPath === null ? [] : [coverPath])]);
    for (const path of paths) {
      await this.files.removeManaged(path).catch(() => {});
    }
  }
  list(q?: string) { return this.books.list(q); }
  catalog(q: string, recent: boolean) { return this.books.catalog(q, recent); }
  listPage(query: BookListQuery): BookPage { return this.requireListReader().page(query); }
  matchingIds(filter: BookListFilter, limit: number): string[] {
    return this.requireListReader().matchingIds(filter, limit);
  }
  /** Tag ids per book, ordered by name; one query per block of 500 ids. */
  tagIdsForBooks(ids: string[]): Map<string, string[]> {
    return this.tags?.forBooks(ids) ?? new Map();
  }
  countBooks(filter?: BookListFilter, options?: { requireProgress?: boolean }): number {
    return this.requireListReader().count(filter, options);
  }
  facets(filter?: BookListFilter, indexingEnabled = true): BookFacets {
    return this.requireListReader().facets(filter, { indexingEnabled });
  }
  booksByIds(ids: string[]): Book[] { return this.requireListReader().byIds(ids); }
  catalogPage(q: string, limit: number, offset: number): Book[] {
    return this.requireListReader().catalogPage({ q }, limit, offset);
  }
  get(id: string) { return this.books.get(id); }
  private requireListReader(): BookListReader {
    if (!this.listReader) throw new Error("Book list reader is not configured");
    return this.listReader;
  }
}
