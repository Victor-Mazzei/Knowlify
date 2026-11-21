import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository, SqliteNoteRepository } from "../src/adapters/storage/repositories.js";
import { noteGroupsQuery, notesForGroupsQuery } from "../src/adapters/storage/SqliteNoteRepository.js";
import { Notes } from "../src/use-cases/Notes.js";

const BOOKS = 11_000;
const BOOKS_WITH_NOTES = 3_000;
const NOTES = 20_000;

const db: Db = openDb(":memory:");
const bookRepository = new SqliteBookRepository(db);
const noteRepository = new SqliteNoteRepository(db);
const notes = new Notes(noteRepository, bookRepository, { now: () => 1 }, { next: () => "id" });

const detail = (query: { sql: string; params: (string | number)[] }): string[] =>
  (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as { detail: string }[])
    .map((row) => row.detail);

function seed(): void {
  const insertBook = db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,status)
    VALUES (?,?,?,?,?,NULL,?,?, 'ready')`);
  const insertNote = db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (let index = 0; index < BOOKS; index += 1) {
      insertBook.run(
        `book-${index}`,
        index % 100 === 0 ? `Dune ${index}` : `Book ${index}`,
        index % 50 === 0 ? "Frank Herbert" : `Author ${index % 500}`,
        index % 2 === 0 ? "pdf" : "epub",
        `/library/book-${index}.pdf`,
        1_000 + index,
        10_000 - index,
      );
    }
    for (let index = 0; index < NOTES; index += 1) {
      const book = index % BOOKS_WITH_NOTES;
      insertNote.run(
        `note-${index}`,
        `book-${book}`,
        "p1",
        index % 20 === 0 ? "label" : "",
        "",
        `Body ${index} with a searchable term`,
        index,
        NOTES - index,
      );
    }
  })();
}

seed();

afterAll(() => db.close());

describe("notes groups storage", () => {
  it("uses the notes_book_updated index for grouping and per-group notes", () => {
    const noQuery = detail(noteGroupsQuery(undefined, undefined, 21));
    expect(noQuery.join("\n")).toContain("notes_book_updated");
    expect(noQuery.join("\n")).toContain("COVERING INDEX notes_book_updated");
    // The final ORDER BY MAX(updated_at) still needs a sort; grouping itself does not.
    expect(noQuery.join("\n")).not.toContain("TEMP B-TREE FOR GROUP BY");

    const withQuery = detail(noteGroupsQuery("term", { lastNoteAt: 1, bookId: "book" }, 21));
    expect(withQuery.join("\n")).toContain("notes_book_updated");

    const groupNotes = detail(notesForGroupsQuery(["book-0", "book-1"], undefined, 5));
    expect(groupNotes.join("\n")).toContain("notes_book_updated");

    const filteredNotes = detail(notesForGroupsQuery(["book-0", "book-1"], "term", 5));
    expect(filteredNotes.join("\n")).toContain("notes_book_updated");
  });

  it("pays five prepared statements for a full page, independent of page size", () => {
    const prepare = vi.spyOn(db, "prepare");
    const page = notes.groups({ limit: "20", perGroup: "5" });
    expect(page.groups).toHaveLength(20);
    expect(page.groups[0].notes).toHaveLength(5);
    expect(prepare).toHaveBeenCalledTimes(5);
    prepare.mockRestore();
  });

  it("pages groups that share lastNoteAt by bookId desc without duplicates", () => {
    const tied = openDb(":memory:");
    try {
      const books = new SqliteBookRepository(tied);
      const repository = new SqliteNoteRepository(tied);
      const cases = new Notes(repository, books, { now: () => 1 }, { next: () => "id" });
      const insertBook = tied.prepare("INSERT INTO books (id,title,author,format,path,size,added_at,status) VALUES (?,?,?,'pdf',?,1,1,'ready')");
      const insertNote = tied.prepare("INSERT INTO notes (id,book_id,body,created_at,updated_at) VALUES (?,?,?,?,?)");
      for (const id of ["a", "b", "c", "d"]) insertBook.run(id, id.toUpperCase(), "", `/${id}.pdf`);
      for (const id of ["a", "b", "c"]) insertNote.run(`tie-${id}`, id, "tie", 1, 300);
      insertNote.run("low-d", "d", "tie", 1, 300);
      insertNote.run("high-d", "d", "newer", 1, 500);
      insertNote.run("high-d-2", "d", "newer id", 1, 500);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = cases.groups({ limit: "2", perGroup: "2", ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.groups.map((group) => group.book.id));
        if (page.groups[0]?.book.id === "d") {
          expect(page.groups[0].notes.map((note) => note.id)).toEqual(["high-d-2", "high-d"]);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toEqual(["d", "c", "b", "a"]);
    } finally {
      tied.close();
    }
  });

  it("keeps p95 under 80 ms with 11k books and 20k notes", () => {
    for (let index = 0; index < 5; index += 1) notes.groups({ limit: "20", perGroup: "5" });
    const durations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const page = notes.groups({ limit: "20", perGroup: "5" });
      durations.push(performance.now() - started);
      expect(page.totalBooks).toBe(BOOKS_WITH_NOTES);
      expect(page.totalNotes).toBe(NOTES);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    expect(p95).toBeLessThan(80);
  });
});
