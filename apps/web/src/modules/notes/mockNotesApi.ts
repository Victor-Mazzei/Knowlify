import type { ApiFn } from "../../components/dialogs";
import type { Note, NoteBook, NoteGroup, NoteGroupsPage } from "./types";

export type MockNotesOptions = {
  books?: number;
  notesPerBook?: number;
  /** Simulates a server that predates `GET /api/notes/groups`. */
  legacy?: boolean;
  failGroups?: boolean;
  failDelete?: boolean;
  /** Test seam for ordering two responses (for example, a stale search). */
  beforeRespond?: (request: { method: string; path: string; url: URL }) => Promise<void> | void;
};

const ADJECTIVES = ["Quiet", "Hidden", "Northern", "Slow", "Bright", "Patient", "Distant", "Open"];
const NOUNS = ["Library", "River", "Archive", "Garden", "Signal", "Atlas", "Orchard", "Harbor"];
const AUTHORS = ["Ada Meridian", "Borges Vale", "Clara North", "Dario Fields", "Elena Marsh"];
const WORDS = ["memory", "attention", "practice", "wonder", "silence", "rhythm", "margin", "signal"];
const BASE = 1_763_600_000_000;
const MINUTE = 60_000;
const ONE_PIXEL_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="),
  (char) => char.charCodeAt(0),
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const notFound = () => json({ message: "Not found" }, 404);

export function createMockNoteData(options: Pick<MockNotesOptions, "books" | "notesPerBook"> = {}) {
  const books = options.books ?? 24;
  const perBook = options.notesPerBook ?? 6;
  const notes: Note[] = [];
  const library: NoteBook[] = [];
  for (let index = 0; index < books; index += 1) {
    const id = `note-book-${String(index + 1).padStart(5, "0")}`;
    const title = `${ADJECTIVES[index % ADJECTIVES.length]} ${NOUNS[Math.floor(index / ADJECTIVES.length) % NOUNS.length]} ${index + 1}`;
    const book: NoteBook = {
      id,
      title,
      author: AUTHORS[index % AUTHORS.length]!,
      format: index % 3 === 0 ? "pdf" : "epub",
      hasCover: index % 2 === 0,
    };
    library.push(book);
    const count = perBook + (index % 3);
    for (let n = 0; n < count; n += 1) {
      const updatedAt = BASE - index * 30 * MINUTE - n * MINUTE;
      const word = WORDS[(index + n) % WORDS.length]!;
      notes.push({
        id: `note-${index + 1}-${n + 1}`,
        bookId: id,
        bookTitle: title,
        location: n % 2 === 0 ? `epubcfi(/6/${2 + n})` : "",
        label: `Page ${n + 3}`,
        quote: n % 2 === 0 ? `A ${word} passage` : "",
        body: `Reading about ${word} in ${title}`,
        createdAt: updatedAt - 5 * MINUTE,
        updatedAt,
      });
    }
  }
  return { notes, books: library };
}

const lower = (value: string) => value.toLowerCase();
function bookMatches(book: NoteBook, q: string) {
  return lower(book.title).includes(q) || lower(book.author ?? "").includes(q);
}
function noteMatches(note: Note, q: string) {
  return [note.body, note.quote, note.label].some((value) => lower(value).includes(q));
}

function encodeCursor(offset: number) {
  return btoa(`offset:${offset}`).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeCursor(cursor: string): number | null {
  try {
    const raw = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const match = /^offset:(\d+)$/.exec(raw);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
const clamp = (value: string | null, fallback: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), max) : fallback;
};

/** In-memory `GET /api/notes/groups`, legacy notes, book notes, covers and delete. */
export function mockNotesApi(
  initial: { notes: Note[]; books: NoteBook[] } = createMockNoteData(),
  options: MockNotesOptions = {},
): ApiFn {
  let notes = [...initial.notes];

  function matchingGroups(q: string) {
    const needle = lower(q.trim());
    return initial.books
      .map((book) => {
        const all = notes.filter((note) => note.bookId === book.id);
        const matched = !needle || bookMatches(book, needle) ? all : all.filter((note) => noteMatches(note, needle));
        return { book, matched };
      })
      .filter((entry) => entry.matched.length > 0)
      .map(({ book, matched }): NoteGroup => {
        const sorted = [...matched].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
        return {
          book,
          noteCount: sorted.length,
          lastNoteAt: sorted[0]!.updatedAt,
          notes: sorted,
          hasMore: false,
        };
      })
      .sort((a, b) => b.lastNoteAt - a.lastNoteAt || b.book.id.localeCompare(a.book.id));
  }

  function groupsResponse(url: URL): Response {
    if (options.legacy) return notFound();
    if (options.failGroups) return json({ message: "Groups are unavailable" }, 500);
    const q = url.searchParams.get("q") ?? "";
    const limit = clamp(url.searchParams.get("limit"), 20, 50);
    const perGroup = clamp(url.searchParams.get("perGroup"), 5, 20);
    const rawCursor = url.searchParams.get("cursor");
    const offset = rawCursor ? decodeCursor(rawCursor) : 0;
    if (offset === null) return json({ message: "Invalid cursor" }, 400);
    const matching = matchingGroups(q);
    const items = matching.slice(offset, offset + limit).map((group) => ({
      ...group,
      notes: group.notes.slice(0, perGroup),
      hasMore: group.noteCount > perGroup,
    }));
    const page: NoteGroupsPage = {
      items,
      nextCursor: offset + limit < matching.length ? encodeCursor(offset + limit) : null,
      totalBooks: matching.length,
      totalNotes: matching.reduce((total, group) => total + group.noteCount, 0),
    };
    return json(page);
  }

  function legacyNotes(url: URL): Response {
    const needle = lower((url.searchParams.get("q") ?? "").trim());
    const matching = notes
      .filter((note) => {
        if (!needle) return true;
        const book = initial.books.find((item) => item.id === note.bookId);
        return (book && bookMatches(book, needle)) || noteMatches(note, needle);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 500);
    return json(matching);
  }

  function bookNotes(bookId: string, url: URL): Response {
    const book = initial.books.find((item) => item.id === bookId);
    const needle = lower((url.searchParams.get("q") ?? "").trim());
    if (!book) return json([]);
    const matching = notes
      .filter((note) => note.bookId === bookId)
      .filter((note) => !needle || bookMatches(book, needle) || noteMatches(note, needle))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return json(matching);
  }

  return async (input, init) => {
    const url = new URL(String(input), "http://mock.local");
    const method = init?.method ?? "GET";
    await options.beforeRespond?.({ method, path: url.pathname, url });
    if (method === "GET" && url.pathname === "/api/notes/groups") return groupsResponse(url);
    if (method === "GET" && url.pathname === "/api/notes") return legacyNotes(url);
    const bookNotesMatch = /^\/api\/books\/([^/]+)\/notes$/.exec(url.pathname);
    if (method === "GET" && bookNotesMatch) return bookNotes(decodeURIComponent(bookNotesMatch[1]!), url);
    const deleteMatch = /^\/api\/notes\/([^/]+)$/.exec(url.pathname);
    if (method === "DELETE" && deleteMatch) {
      if (options.failDelete) return json({ message: "Could not delete" }, 500);
      const id = decodeURIComponent(deleteMatch[1]!);
      const before = notes.length;
      notes = notes.filter((note) => note.id !== id);
      return notes.length === before ? notFound() : new Response(null, { status: 204 });
    }
    const coverMatch = /^\/api\/books\/([^/]+)\/cover$/.exec(url.pathname);
    if (method === "GET" && coverMatch) {
      const book = initial.books.find((item) => item.id === decodeURIComponent(coverMatch[1]!));
      if (!book?.hasCover) return notFound();
      return new Response(ONE_PIXEL_PNG, { headers: { "Content-Type": "image/png" } });
    }
    return notFound();
  };
}
