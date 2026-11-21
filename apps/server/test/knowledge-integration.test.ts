import { afterEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  SqliteBookRepository,
  SqliteNoteRepository,
  SqliteSourceRepository,
} from "../src/adapters/storage/repositories.js";
import { DiskFileStore } from "../src/adapters/files/FileStore.js";
import { EpubMetadataExtractor, PdfMetadataExtractor } from "../src/adapters/files/strategies.js";
import { Library } from "../src/use-cases/Library.js";
import { Scanner } from "../src/use-cases/Scanner.js";
import type { IndexScheduler } from "../src/ports/knowledge.js";

const roots: string[] = [];
const databases: Db[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const epubBytes = (title: string): Buffer => {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile("book.opf", Buffer.from(`<package><metadata><title>${title}</title></metadata></package>`));
  return zip.toBuffer();
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "knowlify-schedule-"));
  roots.push(root);
  const booksDir = join(root, "books");
  const coversDir = join(root, "covers");
  await mkdir(booksDir, { recursive: true });
  const db = openDb(":memory:");
  databases.push(db);
  const books = new SqliteBookRepository(db);
  const notes = new SqliteNoteRepository(db);
  const sources = new SqliteSourceRepository(db);
  const files = new DiskFileStore(booksDir, coversDir);
  const clock = { now: () => 5_000 };
  let next = 0;
  const ids = { next: () => `id-${++next}` };
  const metadata = { epub: new EpubMetadataExtractor(), pdf: new PdfMetadataExtractor() };
  const scheduler: IndexScheduler = { schedule: vi.fn() };
  return { root, booksDir, coversDir, books, notes, sources, files, clock, ids, metadata, scheduler };
}

describe("Library and Scanner enqueue search indexing", () => {
  it("schedules an upload with priority 1 without waiting for ingestion", async () => {
    const s = await setup();
    const upload = join(s.root, "upload.epub");
    await writeFile(upload, epubBytes("Scheduled upload"));
    const library = new Library(s.books, s.notes, s.files, s.clock, s.ids, s.metadata, s.scheduler);
    const imported = await library.importFile(upload, "upload.epub");
    expect(imported.duplicate).toBe(false);
    const book = imported.book;
    expect(book).toMatchObject({ title: "Scheduled upload", status: "ready", source_id: null });
    expect(s.scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(s.scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: book.id, size: book.size }), 1);
  });

  it("schedules a scanned book with priority 0 after metadata is ready", async () => {
    const s = await setup();
    const sourceDir = join(s.root, "library");
    await mkdir(sourceDir, { recursive: true });
    const path = join(sourceDir, "scanned.epub");
    await writeFile(path, epubBytes("Scheduled scan"));
    const log = { info: vi.fn(), error: vi.fn() };
    const scanner = new Scanner(s.books, s.sources, s.files, s.clock, s.ids, s.metadata, log, s.scheduler);
    const source = scanner.addSource(sourceDir);
    await scanner.scan();
    await vi.waitFor(() => expect(scanner.status().pending).toBe(0));
    // scan() starts processPending() in the background; let that loop finish before the DB closes.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const book = s.books.forSource(source.id)[0]!;
    expect(book).toMatchObject({ title: "Scheduled scan", status: "ready" });
    expect(s.scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: book.id, size: book.size }), 0);
  });
});
