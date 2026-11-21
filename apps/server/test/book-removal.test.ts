import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  SqliteBookDuplicateRepository,
  SqliteBookRepository,
  SqliteIgnoredBookRepository,
  SqliteNoteRepository,
  SqliteUnitOfWork,
} from "../src/adapters/storage/repositories.js";
import { SqliteConversationRepository } from "../src/adapters/storage/SqliteConversationRepository.js";
import { SqliteBookListQuery } from "../src/adapters/storage/SqliteBookListQuery.js";
import { SqliteBookMetadataRepository } from "../src/adapters/storage/SqliteBookMetadataRepository.js";
import { SqliteBookIndexRepository, SqlitePassageRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { Indexing } from "../src/use-cases/Indexing.js";
import { BookLocks } from "../src/use-cases/BookLocks.js";
import { BookMetadata } from "../src/use-cases/BookMetadata.js";
import { BookRemoval } from "../src/use-cases/BookRemoval.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { Book, FileStore } from "../src/ports/index.js";
import type { CustomCoverStore } from "../src/ports/library-metadata.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-removal-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
const library = join(root, "external-library");

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let books: SqliteBookRepository;
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
const request = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, payload });

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id, title: `Book ${id}`, author: "Author", format: "epub", path: `/library/${id}.epub`, cover_path: null,
  size: 10, added_at: 1_000, source_id: null, mtime: 1, status: "ready", ...overrides,
});

const epub = (title: string): Buffer => {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile("book.opf", Buffer.from(`<package><metadata><title>${title}</title><creator>Author</creator></metadata><manifest/></package>`));
  return zip.toBuffer();
};

const upload = (bytes: Buffer, name = "upload.epub") => {
  const boundary = `knowlify-${createHash("md5").update(bytes).digest("hex")}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/epub+zip\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: "POST", url: "/api/books", headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
};

beforeAll(async () => {
  await mkdir(library, { recursive: true });
  db = openDb(join(root, "removal.db"));
  books = new SqliteBookRepository(db);
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("DELETE /api/books/:id", () => {
  it("removes a library-folder book, remembers its path/hash and never touches the file", async () => {
    const path = join(library, "folder.epub");
    await writeFile(path, epub("Folder book"));
    const before = await readFile(path);
    const beforeStat = await stat(path);
    const hash = createHash("sha256").update(before).digest("hex");
    db.prepare("INSERT INTO sources (id,path) VALUES ('source',?)").run(library);
    books.save(book("folder", { path, source_id: "source", size: before.length, content_hash: hash }));
    db.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES ('t','T','t','gray',1)").run();
    db.prepare("INSERT INTO book_tags (book_id,tag_id,created_at) VALUES ('folder','t',1)").run();

    const response = await request("DELETE", "/api/books/folder");
    expect(response.statusCode).toBe(204);
    expect(books.get("folder")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM book_tags").get()).toEqual({ n: 0 });
    // The file is byte-for-byte the same and still there.
    expect(await readFile(path)).toEqual(before);
    expect((await stat(path)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(db.prepare("SELECT path, content_hash, managed FROM ignored_books").all()).toEqual([
      { path, content_hash: hash, managed: 0 },
    ]);
  });

  it("requires confirmNotes and changes nothing on the 409", async () => {
    const path = join(library, "notes.epub");
    await writeFile(path, epub("Notes book"));
    books.save(book("notes", { path, source_id: "source" }));
    const noteId = "note-1";
    db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
      VALUES (?,?,'','','','body',1,1)`).run(noteId, "notes");

    const blocked = await request("DELETE", "/api/books/notes");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ message: expect.any(String), code: "notes_confirmation_required", notes: 1 });
    expect(books.get("notes")).toBeDefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ignored_books WHERE path = ?").get(path)).toEqual({ n: 0 });

    expect((await request("DELETE", "/api/books/notes?confirmNotes=1")).statusCode).toBe(204);
    expect(books.get("notes")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 0 });
    expect((await stat(path)).isFile()).toBe(true);
  });
});

describe("POST /api/books/delete", () => {
  it("dry-runs without effects and reports the impact", async () => {
    const external = join(library, "dry.epub");
    await writeFile(external, epub("Dry external"));
    books.save(book("dry-external", { path: external, source_id: "source" }));
    const uploaded = await upload(epub("Dry upload"), "dry.epub");
    expect(uploaded.statusCode).toBe(201);
    const uploadId = uploaded.json().id as string;
    db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
      VALUES ('dry-note',?,'','','','body',1,1)`).run(uploadId);
    db.prepare("INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES (?, '1', 0.5, 1)").run(uploadId);
    db.prepare("INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at) VALUES (?, 'ready', 0, 3, 1)").run(uploadId);

    const response = await request("POST", "/api/books/delete", {
      selection: { ids: ["dry-external", uploadId] },
      dryRun: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      books: 2, notes: 1, conversations: 0, withProgress: 1, indexed: 1,
      managedFiles: 1, externalBooks: 1, wouldIgnore: 1,
    });
    expect(books.get("dry-external")).toBeDefined();
    expect(books.get(uploadId)).toBeDefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM ignored_books WHERE path = ?").get(external)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ignored_books WHERE title = 'Dry upload'").get()).toEqual({ n: 0 });
  });

  it("deletes a batch, ignores duplicates and reports missing ids", async () => {
    const paths = ["batch-a", "batch-b"].map((id) => join(library, `${id}.epub`));
    for (const [index, path] of paths.entries()) {
      await writeFile(path, epub(`Batch ${index}`));
      books.save(book(`batch-${index}`, { path, source_id: "source" }));
    }
    const response = await request("POST", "/api/books/delete", {
      selection: { ids: ["batch-0", "batch-0", "missing", "batch-1"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      removed: 2, missing: 1, notesRemoved: 0, ignored: 2, filesRemoved: 0, fileErrors: 0, remaining: 0,
    });
    expect(books.get("batch-0")).toBeUndefined();
    expect(books.get("batch-1")).toBeUndefined();
    // Deleting again is idempotent: both ids are now missing.
    expect((await request("POST", "/api/books/delete", { selection: { ids: ["batch-0"] } })).json())
      .toMatchObject({ removed: 0, missing: 1 });
  });

  it("deletes a filter selection and reports remaining", async () => {
    for (let index = 0; index < 3; index += 1) {
      const path = join(library, `selection-${index}.epub`);
      await writeFile(path, epub(`Selection ${index}`));
      books.save(book(`selection-${index}`, { path, source_id: "source", title: "Selection batch" }));
    }
    const response = await request("POST", "/api/books/delete", {
      selection: { filter: { q: "Selection batch" }, expectedTotal: 3 },
    });
    expect(response.json()).toMatchObject({ removed: 3, missing: 0, remaining: 0 });
    const stale = await request("POST", "/api/books/delete", {
      selection: { filter: { q: "Selection batch" }, expectedTotal: 3 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ message: expect.any(String), code: "selection_changed", total: 0 });
  });

  it("ignores the content hash of a canonical that still has aliases", async () => {
    const path = join(library, "canonical.epub");
    await writeFile(path, epub("Canonical"));
    const hash = createHash("sha256").update(await readFile(path)).digest("hex");
    books.save(book("canonical", { path, source_id: "source", content_hash: hash }));
    const aliasPath = join(library, "copy.epub");
    await writeFile(aliasPath, await readFile(path));
    db.prepare(`INSERT INTO book_duplicates (path,book_id,source_id,size,mtime,content_hash,detected_at)
      VALUES (?,?,'source',?,?,?,1)`).run(aliasPath, "canonical", 1, 1, hash);
    expect((await request("DELETE", "/api/books/canonical")).statusCode).toBe(204);
    expect(await readFile(aliasPath)).toEqual(await readFile(path));
    expect(db.prepare("SELECT content_hash FROM ignored_books WHERE content_hash = ?").all(hash)).toEqual([{ content_hash: hash }]);
  });

  it("deletes a managed upload only after the commit and counts file errors", async () => {    const uploaded = await upload(epub("Managed"), "managed.epub");
    const uploadId = uploaded.json().id as string;
    const row = books.get(uploadId)!;
    const storedPath = row.path;
    expect((await stat(storedPath)).isFile()).toBe(true);

    const failingFiles = {
      removeManaged: vi.fn(async () => { throw new Error("disk is read-only"); }),
      statIfExists: async () => ({ size: row.size, mtime: row.mtime ?? 1 }),
    } as unknown as Pick<FileStore, "removeManaged" | "statIfExists">;
    const removal = new BookRemoval(
      books,
      new SqliteNoteRepository(db),
      new SqliteConversationRepository(db),
      new SqliteIgnoredBookRepository(db),
      new SqliteBookDuplicateRepository(db),
      new SqliteBookListQuery(db),
      new SqliteUnitOfWork(db),
      failingFiles,
      { invalidate: vi.fn(async () => {}) },
      { now: () => 1 },
      { next: () => `generated-${Math.random()}` },
      { info: () => {}, error: () => {}, warn: () => {} },
    );
    const result = await removal.remove({ ids: [uploadId] });
    expect(result).toMatchObject({ removed: 1, missing: 0, filesRemoved: 0, fileErrors: 1 });
    // The database change is committed even though the file could not be removed.
    expect(books.get(uploadId)).toBeUndefined();
    // An upload without aliases needs no tombstone; nothing could re-import it.
    expect(db.prepare("SELECT COUNT(*) AS n FROM ignored_books WHERE content_hash = ?").get(row.content_hash)).toEqual({ n: 0 });
  });
  it("un-ignores the content when the user uploads it again", async () => {
    const bytes = epub("Restored upload");
    const hash = createHash("sha256").update(bytes).digest("hex");
    db.prepare(`INSERT INTO ignored_books (id,path,source_id,content_hash,size,title,author,format,managed,ignored_at)
      VALUES ('tomb-restore',NULL,NULL,?,?, 'Restored upload','', 'epub',1,1)`).run(hash, bytes.length);

    const response = await upload(bytes, "restored.epub");
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ restoredFromIgnored: true, title: "Restored upload" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ignored_books WHERE content_hash = ?").get(hash)).toEqual({ n: 0 });
    expect(books.get(response.json().id as string)).toBeDefined();
  });
});

interface RemovalHarness {
  removal: BookRemoval;
  removeManaged: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
  invalidate: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
}

const removalHarness = (
  unitOfWork: { run<T>(fn: () => T): T } = new SqliteUnitOfWork(db),
): RemovalHarness => {
  const removeManaged = vi.fn(async (_path: string) => true);
  const invalidate = vi.fn(async (_id: string) => undefined);
  const removal = new BookRemoval(
    books,
    new SqliteNoteRepository(db),
    new SqliteConversationRepository(db),
    new SqliteIgnoredBookRepository(db),
    new SqliteBookDuplicateRepository(db),
    new SqliteBookListQuery(db),
    unitOfWork,
    { removeManaged, statIfExists: async () => null },
    { invalidate },
    { now: () => 1 },
    { next: () => `generated-${randomUUID()}` },
    { info: () => {}, error: () => {}, warn: () => {} },
  );
  return { removal, removeManaged, invalidate };
};

const saveNote = (id: string, bookId: string): void => {
  db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
    VALUES (?,?,'','','','body',1,1)`).run(id, bookId);
};

describe("notes written while a deletion is running", () => {
  it("reports the remaining ids when a note lands between the review and the first block", async () => {
    const title = "Ids race batch";
    const ids = Array.from({ length: 100 }, (_, index) => `ids-race-${index}`);
    for (const [index, id] of ids.entries()) {
      books.save(book(id, { path: `/managed/${id}.epub`, title, size: 2_000 + index }));
    }
    const ordered = new SqliteBookListQuery(db).matchingIds({ q: title }, 200);
    expect(ordered).toHaveLength(100);
    const noteBookId = ordered[50]!;

    const real = new SqliteUnitOfWork(db);
    let noteSaved = false;
    const unitOfWork = {
      run<T>(fn: () => T): T {
        // Mimics another request saving a note after the initial review, before the block.
        if (!noteSaved) {
          noteSaved = true;
          saveNote("ids-race-note", noteBookId);
        }
        return real.run(fn);
      },
    };
    const { removal, removeManaged } = removalHarness(unitOfWork);

    const error = await removal.remove({ ids: ordered }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "ConflictError", code: "selection_changed" });
    expect((error as { details: unknown }).details).toEqual({ removed: 0, remainingIds: ordered });
    expect(books.get(noteBookId)).toBeDefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE book_id = ?").get(noteBookId)).toEqual({ n: 1 });
    // Nothing was deleted, so no managed file was touched.
    expect(removeManaged).not.toHaveBeenCalled();

    const retried = await removal.remove({ ids: ordered }, { confirmNotes: true });
    expect(retried).toMatchObject({ removed: 100, missing: 0, notesRemoved: 1 });
    expect(books.get(noteBookId)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE book_id = ?").get(noteBookId)).toEqual({ n: 0 });
  });

  it("cleans the committed blocks and reports the filter remainder when a note lands between blocks", async () => {
    const title = "Race batch";
    const ids = Array.from({ length: 150 }, (_, index) => `race-${index}`);
    for (const [index, id] of ids.entries()) {
      books.save(book(id, { path: `/managed/${id}.epub`, title, size: 1_000 + index }));
    }
    const listReader = new SqliteBookListQuery(db);
    const ordered = listReader.matchingIds({ q: title }, 200);
    expect(ordered).toHaveLength(150);
    // One note was part of the reviewed impact (block 1) and the user confirmed it.
    saveNote("race-existing", ordered[0]!);
    // The second note lands on a book of the second block after the review, so it was not
    // part of the confirmation even though `confirmNotes` is true.
    const noteBookId = ordered[120]!;

    const real = new SqliteUnitOfWork(db);
    let blocks = 0;
    const unitOfWork = {
      run<T>(fn: () => T): T {
        const result = real.run(fn);
        blocks += 1;
        if (blocks === 1) {
          // Mimics another request saving a note while execute() yields between blocks.
          setImmediate(() => saveNote("race-note", noteBookId));
        }
        return result;
      },
    };
    const { removal, removeManaged, invalidate } = removalHarness(unitOfWork);

    const error = await removal.remove({ filter: { q: title }, expectedTotal: 150 }, { confirmNotes: true })
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "ConflictError", code: "selection_changed" });
    expect((error as { details: unknown }).details).toEqual({
      removed: 100,
      remainingTotal: 50,
      remainingIds: ordered.slice(100),
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE book_id = ?").get(noteBookId)).toEqual({ n: 1 });
    expect(books.get(noteBookId)).toBeDefined();
    // The confirmations from the review were honored: the block-1 note is gone with its book.
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id = 'race-existing'").get()).toEqual({ n: 0 });
    // Block-level atomicity: the first block had already committed when the conflict appeared.
    expect(books.get(ordered[0]!)).toBeUndefined();

    // The files and covers of the committed block are cleaned before the 409 is returned.
    expect(removeManaged.mock.calls.map(([path]) => path).sort())
      .toEqual(ordered.slice(0, 100).map((id) => `/managed/${id}.epub`).sort());
    expect(invalidate.mock.calls.map(([id]) => id)).toEqual(ordered.slice(0, 100));

    // Reconfirming with the remaining ids finishes the job, including the note.
    const remainingIds = (error as { details: { remainingIds: string[] } }).details.remainingIds;
    const retried = await removal.remove({ ids: remainingIds }, { confirmNotes: true });
    expect(retried).toMatchObject({ removed: 50, missing: 0, notesRemoved: 1 });
    expect(books.get(noteBookId)).toBeUndefined();

    // Ids deleted by the first attempt are idempotent: they only count as missing.
    const again = await removal.remove({ ids: ordered.slice(0, 10) });
    expect(again).toMatchObject({ removed: 0, missing: 10 });
  });

  it("omits remainingIds when a filter still has more than the response ceiling", async () => {
    const title = "Huge race batch";
    for (let index = 0; index < 1_200; index += 1) {
      const id = `huge-race-${index}`;
      books.save(book(id, { path: join(library, `${id}.epub`), source_id: "source", title, size: 3_000 + index }));
    }
    const ordered = new SqliteBookListQuery(db).matchingIds({ q: title }, 2_000);
    expect(ordered).toHaveLength(1_200);
    const noteBookId = ordered[150]!;

    const real = new SqliteUnitOfWork(db);
    let blocks = 0;
    const unitOfWork = {
      run<T>(fn: () => T): T {
        const result = real.run(fn);
        blocks += 1;
        if (blocks === 1) setImmediate(() => saveNote("huge-race-note", noteBookId));
        return result;
      },
    };
    const { removal } = removalHarness(unitOfWork);

    const error = await removal.remove({ filter: { q: title }, expectedTotal: 1_200 }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "ConflictError", code: "selection_changed" });
    expect((error as { details: unknown }).details).toEqual({ removed: 100, remainingTotal: 1_100 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE book_id = ?").get(noteBookId)).toEqual({ n: 1 });
  });
});

describe("deletion during ingestion", () => {
  it("does not leave chunks or book_index behind when the book disappears mid-run", async () => {
    const indexDb = openDb(":memory:");
    const indexBooks = new SqliteBookRepository(indexDb);
    const indexes = new SqliteBookIndexRepository(indexDb);
    const passages = new SqlitePassageRepository(indexDb);
    indexBooks.save(book("in-flight", { source_id: "source", mtime: 1, size: 10 }));

    let capturedSink: import("../src/ports/knowledge.js").IngestSink | null = null;
    let indexingRef: Indexing | null = null;
    let releaseRun!: () => void;
    const runPromise = new Promise<void>((resolve) => { releaseRun = resolve; });
    const started = new Promise<void>((resolve) => {
      const runner = {
        run: async (_job: unknown, sink: import("../src/ports/knowledge.js").IngestSink) => {
          capturedSink = sink;
          resolve();
          await runPromise;
          return { kind: "done" as const, contentHash: "b".repeat(64), chunkCount: 1, indexVersion: "1|none" };
        },
        embedQuery: async () => null,
        embeddings: () => ({ mode: "none" as const, model: null, state: "off" as const }),
        indexVersion: () => "1|none",
        onEmbeddingsReady: () => {},
        close: async () => {},
      };
      const indexing = new Indexing(indexes, passages, indexBooks, runner, { now: () => 1 }, {
        enabled: true, maxBytes: 1_000, concurrency: 1, backfill: "off", workers: 1,
      }, { info: () => {}, error: () => {} });
      indexingRef = indexing;
      indexing.start();
      indexing.schedule(indexBooks.get("in-flight")!, 1);
    });
    await started;
    expect(capturedSink).not.toBeNull();

    // The deletion cascades book_index away while the runner is still working.
    indexBooks.deleteMany(["in-flight"]);
    expect(indexes.get("in-flight")).toBeUndefined();

    capturedSink!.onStart(null);
    await expect(capturedSink!.onBatch({
      passages: [{ ordinal: 0, text: "should never be stored", page: null, section: null }],
      vectors: null,
    })).rejects.toThrow();
    releaseRun();

    expect(indexDb.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 0 });
    expect(indexDb.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get()).toEqual({ n: 0 });
    expect(indexes.get("in-flight")).toBeUndefined();
    indexingRef?.stop();
    indexDb.close();
  });
});

describe("deletion and cover edits share the per-book lock", () => {
  it("waits for an in-flight cover upload before deleting the book", async () => {
    books.save(book("locked-delete", { cover_path: null }));
    const locks = new BookLocks();
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });

    const covers: CustomCoverStore = {
      save: vi.fn(async () => {
        uploadStarted();
        await uploadGate;
        return "/covers/custom/locked-delete.jpg";
      }),
      remove: vi.fn(async () => {}),
      move: vi.fn(async () => null),
    };
    const metadata = new BookMetadata(
      books,
      new SqliteBookMetadataRepository(db),
      covers,
      { invalidate: async () => {} },
      { now: () => 1_000 },
      {},
      locks,
    );
    const removeManaged = vi.fn(async (_path: string) => true);
    const removal = new BookRemoval(
      books,
      new SqliteNoteRepository(db),
      new SqliteConversationRepository(db),
      new SqliteIgnoredBookRepository(db),
      new SqliteBookDuplicateRepository(db),
      new SqliteBookListQuery(db),
      new SqliteUnitOfWork(db),
      { removeManaged, statIfExists: async () => null },
      { invalidate: async () => {} },
      { now: () => 1 },
      { next: () => `generated-${randomUUID()}` },
      { info: () => {}, error: () => {}, warn: () => {} },
      locks,
    );

    const setting = metadata.setCover("locked-delete", Buffer.from("image"));
    await started;
    const removing = removal.removeOne("locked-delete");
    await Promise.resolve();

    // The deletion holds the same book lock, so the upload must finish first.
    expect(removeManaged).not.toHaveBeenCalled();
    expect(books.get("locked-delete")).toBeDefined();

    releaseUpload();
    expect(await setting).not.toBeNull();
    expect(await removing).toMatchObject({ removed: 1 });
    expect(books.get("locked-delete")).toBeUndefined();
    expect(removeManaged).toHaveBeenCalledWith("/covers/custom/locked-delete.jpg");
  });
});
