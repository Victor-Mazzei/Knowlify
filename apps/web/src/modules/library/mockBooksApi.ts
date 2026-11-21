import type { ApiFn } from "../../components/dialogs";
import type { Book, BookPage, Format, IgnoredBook, Tag } from "../../types";
import type { BookDetail, BookMetadata } from "../book/types";
import { ignoredEntryFromBook, restoredBook } from "../ignored/mockIgnoredApi";
import type { Note } from "../notes/types";
import { isTagColor, normalizeTagName as normalizeTagNameForApi, TAG_NAME_MAX } from "../tags/tagColors";
import { SEED_TAGS, tagCounts, tagKey, withSeedTags } from "../tags/mockTagsApi";
import {
  computeFacets,
  hasNotes,
  indexStateOf,
  KNOWN_SOURCE_IDS,
  listPage,
  matchesListQuery,
  numericIdOf,
  parseMockQuery,
  sourceIdOf,
  type MockListQuery,
  type MockOptions,
} from "./mockBooksQuery";

const ADJECTIVES = ["Quiet", "Hidden", "Northern", "Slow", "Bright", "Patient", "Distant", "Open"];
const NOUNS = ["Library", "River", "Archive", "Garden", "Signal", "Atlas", "Orchard", "Harbor"];
const BASE_ADDED_AT = 1_760_000_000_000;
const ONE_PIXEL_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="),
  (char) => char.charCodeAt(0),
);

export type MockBookOptions = { count?: number };
export type MockBooksApiOptions = {
  facets?: boolean;
  indexing?: boolean;
  /** `false` simulates the tags-era server that has no favorite contract. */
  favorites?: boolean;
  /**
   * Simulates a server with the metadata routes. Off by default: the metadata
   * dialogs are scaffold stubs until the fe-metadata track replaces them.
   */
  metadata?: boolean;
  /**
   * One-shot server race: the next confirmed deletion removes this many books,
   * then answers `409 selection_changed` with the remainder, like the real
   * endpoint when a note is created between blocks.
   */
  partialDeleteAfter?: number;
};

/** Deterministic library used by tests and by the optional `VITE_MOCK_BOOKS=1` dev mode. */
export function createMockBooks({ count = 11_000 }: MockBookOptions = {}): Book[] {
  return Array.from({ length: count }, (_, index) => {
    const pending = index % 1000 === 999;
    const format: Format = index % 3 === 0 ? "pdf" : "epub";
    return {
      id: `mock-${String(index + 1).padStart(5, "0")}`,
      title: `${ADJECTIVES[index % ADJECTIVES.length]} ${NOUNS[Math.floor(index / ADJECTIVES.length) % NOUNS.length]} ${index + 1}`,
      author: `Author ${(index % 37) + 1}`,
      format,
      size: 600_000 + (index % 90) * 250_000,
      addedAt: BASE_ADDED_AT - index * 60_000,
      hasCover: index % 3 === 0,
      status: pending ? "pending" : "ready",
      source: index % 2 === 0,
      index: { state: pending ? "pending" : "ready", error: null },
      progress:
        index % 5 === 0
          ? { percentage: ((index % 97) + 1) / 100, updatedAt: BASE_ADDED_AT - index * 60_000 }
          : null,
      favorite: index % 7 === 0,
      coverRev: null,
    };
  });
}

const MOCK_DESCRIPTION = [
  "A quiet, closely observed book about the habits that make a reading life: what we keep, what we lend, and what we finally return to.",
  "Across its chapters the argument builds slowly, from the margins of a single page to the shelves of a whole town. Notes and citations are treated as part of the story rather than as apparatus.",
  "Readers who like their criticism practical will find a short method at the end: read a little, write it down, and let the next book answer back.",
].join("\n\n");

const MOCK_PUBLISHERS = ["Northline Press", "Harbor & Vale", "Meridian House"];

/** Deterministic effective metadata so the details page exercises every chip. */
function mockMetadataOf(book: Book): BookMetadata {
  const n = numericIdOf(book.id);
  const edited = n % 2 === 0;
  const withSeries = edited && n % 6 === 0;
  return {
    title: book.title,
    author: book.author,
    description: edited ? MOCK_DESCRIPTION : null,
    isbn10: null,
    isbn13: edited ? `978030640${String(1000 + (n % 9000))}` : null,
    year: edited ? 1980 + (n % 40) : null,
    publisher: edited ? MOCK_PUBLISHERS[n % MOCK_PUBLISHERS.length]! : null,
    language: edited ? "en" : null,
    series: withSeries ? "The Quiet Archive" : null,
    seriesIndex: withSeries ? (n % 5) + 1 : null,
    file: { title: book.title, author: book.author },
    overridden: {
      title: false,
      author: false,
      description: edited,
      isbn10: false,
      isbn13: edited,
      year: edited,
      publisher: edited,
      language: edited,
      series: withSeries,
      cover: false,
    },
    source: edited ? "manual" : null,
    updatedAt: edited ? BASE_ADDED_AT : null,
  };
}

function mockDetailOf(book: Book): BookDetail {
  return {
    ...book,
    favorite: book.favorite ?? false,
    coverRev: book.coverRev ?? null,
    tagIds: book.tagIds ?? [],
    metadata: mockMetadataOf(book),
  };
}

/** One in twenty books has notes, matching `hasNotes` in mockBooksQuery. */
function mockNotesOf(book: Book): Note[] {
  const n = numericIdOf(book.id);
  if (n % 20 !== 0) return [];
  const words = ["attention", "memory", "margins", "practice"];
  return Array.from({ length: 4 }, (_, index) => {
    const updatedAt = BASE_ADDED_AT - index * 3_600_000;
    const word = words[index % words.length]!;
    return {
      id: `mock-note-${n}-${index + 1}`,
      bookId: book.id,
      bookTitle: book.title,
      location: index % 2 === 0 ? `epubcfi(/6/${2 + index * 2})` : "",
      label: `Page ${12 + index * 7}`,
      quote: index % 2 === 0 ? `A passage about ${word}.` : "",
      body: `What ${word} means for how I read ${book.title}.`,
      createdAt: updatedAt - 900_000,
      updatedAt,
    };
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const badRequest = (message: string) => json({ message }, 400);
const conflict = (message: string, code: string) => json({ message, code }, 409);
const notFound = () => json({ message: "Not found" }, 404);

const bodyOf = (init?: RequestInit): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(String(init?.body ?? "{}"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const stringArray = (value: unknown, max: number): string[] | null => {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((entry): entry is string => typeof entry === "string");
  return ids.length === value.length && ids.length <= max ? [...new Set(ids)] : null;
};

/**
 * In-memory implementation of the `GET /api/books` contract. It answers the same
 * paged envelope, legacy array, ids lookup, covers and the small status endpoints
 * the shell polls, so the library can run without a server.
 *
 * `facets: false` simulates a server that predates the filter endpoints: filters
 * are ignored and `GET /api/books/facets` answers 404.
 */
export function mockBooksApi(initial: Book[] = createMockBooks(), overrides: MockBooksApiOptions = {}): ApiFn {
  const options: MockOptions = {
    facets: overrides.facets ?? true,
    indexing: overrides.indexing ?? true,
    favorites: overrides.favorites ?? true,
  };
  const metadataEnabled = overrides.metadata ?? false;
  const partialDeleteAfter = overrides.partialDeleteAfter;
  let books = withSeedTags(initial);
  let tags: Tag[] = [...SEED_TAGS];
  let ignored: IgnoredBook[] = [];
  let paused = false;
  let revision = 1;
  let partialUsed = false;

  function indexCounts() {
    const counts = { pending: 0, indexing: 0, ready: 0, error: 0 };
    for (const book of books) {
      const state = book.index?.state;
      if (state === "pending" || state === "indexing" || state === "ready" || state === "error") counts[state] += 1;
    }
    return counts;
  }

  function sources() {
    const names: Record<string, string> = { "source-1": "Fiction", "source-2": "Reference" };
    return KNOWN_SOURCE_IDS.map((id) => ({
      id,
      path: `/library/${names[id] ?? id}`,
      accessible: true,
      books: books.filter((book) => sourceIdOf(book) === id).length,
    }));
  }

  async function addBook(init?: RequestInit): Promise<Response> {
    const body = init?.body;
    const file = body instanceof FormData ? body.get("file") : null;
    const name = file instanceof File ? file.name : "Imported book.epub";
    const title = name.replace(/\.(pdf|epub)$/i, "");
    const book: Book = {
      id: `upload-${Date.now()}`,
      title,
      author: "",
      format: name.toLowerCase().endsWith(".pdf") ? "pdf" : "epub",
      size: file instanceof File ? file.size : 0,
      addedAt: Date.now(),
      hasCover: false,
      status: "pending",
      source: false,
      index: { state: "pending", error: null },
      progress: null,
      tagIds: [],
      favorite: false,
      coverRev: null,
    };
    books = [book, ...books];
    return json(book, 201);
  }

  type MockSelection = { ids: string[]; missing: number; filter: MockListQuery | null };

  function resolveSelection(value: unknown, maxIds: number): MockSelection | { response: Response } {
    if (typeof value !== "object" || value === null) return { response: badRequest("selection is required") };
    const selection = value as Record<string, unknown>;
    if (selection.ids !== undefined) {
      const ids = stringArray(selection.ids, maxIds);
      if (!ids) return { response: badRequest(`selection.ids must be a list of up to ${maxIds} ids`) };
      const found = ids.filter((id) => books.some((book) => book.id === id));
      return { ids: found, missing: ids.length - found.length, filter: null };
    }
    if (typeof selection.filter === "object" && selection.filter !== null) {
      const filter = selection.filter as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const key of ["q", "format", "read", "index", "source", "notes", "favorite", "tag"]) {
        if (typeof filter[key] === "string") params.set(key, filter[key]);
      }
      const parsed = parseMockQuery(params, options);
      if (!parsed.ok) return { response: badRequest(parsed.message) };
      const matched = books.filter((book) => matchesListQuery(book, parsed.query));
      const expected = selection.expectedTotal;
      if (typeof expected !== "number" || expected !== matched.length) {
        return {
          response: json(
            { message: "The filtered selection changed", code: "selection_changed", total: matched.length },
            409,
          ),
        };
      }
      if (matched.length > 20_000) {
        return {
          response: json({ message: "Selection too large", code: "selection_too_large" }, 409),
        };
      }
      return { ids: matched.map((book) => book.id), missing: 0, filter: parsed.query };
    }
    return { response: badRequest("selection.ids or selection.filter is required") };
  }

  function replaceTagIds(book: Book, change: { add?: string[]; remove?: string[] }) {
    const ids = new Set(book.tagIds ?? []);
    let added = 0;
    let removed = 0;
    for (const id of change.add ?? []) {
      if (!ids.has(id)) {
        ids.add(id);
        added += 1;
      }
    }
    for (const id of change.remove ?? []) {
      if (ids.delete(id)) removed += 1;
    }
    return { book: { ...book, tagIds: [...ids] }, added, removed };
  }

  function impact(selected: Book[]) {
    return {
      books: selected.length,
      notes: selected.filter(hasNotes).length,
      conversations: selected.filter((book) => numericIdOf(book.id) % 40 === 0).length,
      withProgress: selected.filter((book) => book.progress != null).length,
      indexed: selected.filter((book) => indexStateOf(book) === "ready").length,
      managedFiles: selected.filter((book) => !book.source).length,
      externalBooks: selected.filter((book) => book.source).length,
      wouldIgnore: selected.filter((book) => book.source).length,
    };
  }

  function deleteSelected(
    selected: Book[],
    confirmNotes: boolean,
  ): { response: Response } | { removed: number; notes: number; ignored: number } {
    const notes = selected.filter(hasNotes).length;
    if (notes > 0 && !confirmNotes) {
      return {
        response: json(
          { message: "Notes must be confirmed", code: "notes_confirmation_required", notes },
          409,
        ),
      };
    }
    // Uploads only need a content tombstone when a folder copy exists (an alias).
    // The mock does not model aliases, so it mirrors the common case: no entry.
    const external = selected.filter((book) => book.source);
    for (const book of external) ignored = [...ignored, ignoredEntryFromBook(book)];
    const ids = new Set(selected.map((book) => book.id));
    books = books.filter((book) => !ids.has(book.id));
    return { removed: selected.length, notes, ignored: external.length };
  }

  async function handleTagRoutes(url: URL, method: string, init?: RequestInit): Promise<Response | null> {
    if (!options.facets) return null;
    if (url.pathname === "/api/tags") {
      if (method === "GET") return json({ items: tagCounts(books, tags) });
      if (method !== "POST") return null;
      const body = bodyOf(init);
      const rawName = typeof body?.name === "string" ? normalizeTagNameForApi(body.name) : "";
      const color = body?.color ?? "gray";
      if (!rawName || rawName.length > TAG_NAME_MAX || /[\u0000-\u001f\u007f]/.test(rawName)) {
        return badRequest("Invalid tag name");
      }
      if (color !== "gray" && !isTagColor(color)) {
        return badRequest("Invalid tag color");
      }
      if (tags.length >= 200) return conflict("Tag limit reached", "tag_limit_reached");
      if (tags.some((tag) => tagKey(tag.name) === tagKey(rawName))) {
        return conflict("Tag name already exists", "tag_name_taken");
      }
      const tag: Tag = {
        id: `tag-${Date.now()}-${tags.length}`,
        name: rawName,
        color: color as Tag["color"],
        createdAt: Date.now(),
      };
      tags = [...tags, tag];
      return json(tag, 201);
    }
    const detail = url.pathname.match(/^\/api\/tags\/([^/]+)$/);
    if (!detail) return null;
    const id = decodeURIComponent(detail[1]!);
    const existing = tags.find((tag) => tag.id === id);
    if (!existing) return notFound();
    if (method === "DELETE") {
      tags = tags.filter((tag) => tag.id !== id);
      books = books.map((book) => ({
        ...book,
        tagIds: (book.tagIds ?? []).filter((tagId) => tagId !== id),
      }));
      return new Response(null, { status: 204 });
    }
    if (method !== "PATCH") return null;
    const body = bodyOf(init);
    if (!body || (body.name === undefined && body.color === undefined)) return badRequest("Nothing to update");
    let name = existing.name;
    if (body.name !== undefined) {
      name = typeof body.name === "string" ? normalizeTagNameForApi(body.name) : "";
      if (!name || name.length > TAG_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return badRequest("Invalid tag name");
      if (tags.some((tag) => tag.id !== id && tagKey(tag.name) === tagKey(name))) {
        return conflict("Tag name already exists", "tag_name_taken");
      }
    }
    const color = body.color ?? existing.color;
    if (!isTagColor(color)) {
      return badRequest("Invalid tag color");
    }
    const tag: Tag = { ...existing, name, color: color as Tag["color"] };
    tags = tags.map((entry) => (entry.id === id ? tag : entry));
    return json(tag);
  }

  return async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, "http://mock.knowlify");
    const method = init?.method ?? "GET";
    const tagResponse = await handleTagRoutes(url, method, init);
    if (tagResponse) return tagResponse;
    if (url.pathname === "/api/metadata/status") {
      return metadataEnabled
        ? json({
            enabled: true,
            providers: [
              { id: "googlebooks", keyConfigured: false },
              { id: "openlibrary", keyConfigured: false },
            ],
          })
        : notFound();
    }
    if (url.pathname === "/api/books/tags" && method === "PATCH") {
      if (!options.facets) return notFound();
      const body = bodyOf(init);
      const add = body?.add === undefined ? [] : stringArray(body.add, 20);
      const remove = body?.remove === undefined ? [] : stringArray(body.remove, 20);
      if (!add || !remove) return badRequest("add/remove must be lists of up to 20 tag ids");
      if (add.length === 0 && remove.length === 0) return badRequest("add or remove is required");
      if (add.some((id) => remove.includes(id))) return badRequest("add and remove must be disjoint");
      if (add.some((id) => !tags.some((tag) => tag.id === id))) {
        return json({ message: "Tag not found", code: "tag_not_found" }, 404);
      }
      const resolved = resolveSelection(body?.selection, 200);
      if ("response" in resolved) return resolved.response;
      const selected = new Set(resolved.ids);
      const overflow = books.some((book) => {
        if (!selected.has(book.id)) return false;
        const ids = new Set(book.tagIds ?? []);
        for (const id of add) ids.add(id);
        return ids.size > 50;
      });
      if (overflow) return conflict("A book cannot have more than 50 tags", "book_tag_limit");
      let added = 0;
      let removed = 0;
      books = books.map((book) => {
        if (!selected.has(book.id)) return book;
        const next = replaceTagIds(book, { add, remove });
        added += next.added;
        removed += next.removed;
        return next.book;
      });
      return json({ matched: selected.size, added, removed });
    }
    if (url.pathname === "/api/books/favorite" && method === "PATCH") {
      if (!options.facets || !options.favorites) return notFound();
      const body = bodyOf(init);
      if (typeof body?.favorite !== "boolean") return badRequest("favorite must be a boolean");
      const resolved = resolveSelection(body, 100);
      if ("response" in resolved) return resolved.response;
      const selected = new Set(resolved.ids);
      books = books.map((book) => (selected.has(book.id) ? { ...book, favorite: body.favorite as boolean } : book));
      return json({ updated: selected.size });
    }
    const favorite = url.pathname.match(/^\/api\/books\/([^/]+)\/favorite$/);
    if (favorite && (method === "PUT" || method === "DELETE")) {
      if (!options.facets || !options.favorites) return notFound();
      const id = decodeURIComponent(favorite[1]!);
      if (!books.some((book) => book.id === id)) return notFound();
      const next = method === "PUT";
      books = books.map((book) => (book.id === id ? { ...book, favorite: next } : book));
      return json({ favorite: next });
    }
    if (url.pathname === "/api/books/delete" && method === "POST") {
      if (!options.facets) return notFound();
      const body = bodyOf(init);
      const resolved = resolveSelection(body?.selection, 100);
      if ("response" in resolved) return resolved.response;
      const selected = books.filter((book) => resolved.ids.includes(book.id));
      if (body?.dryRun === true) return json(impact(selected));
      const notes = selected.filter(hasNotes).length;
      if (notes > 0 && body?.confirmNotes !== true) {
        return json({ message: "Notes must be confirmed", code: "notes_confirmation_required", notes }, 409);
      }
      const filterQuery = resolved.filter;
      const partialAfter =
        !partialUsed && partialDeleteAfter !== undefined
          ? Math.max(0, Math.min(partialDeleteAfter, selected.length))
          : selected.length;
      if (partialAfter < selected.length) {
        partialUsed = true;
        const block = selected.slice(0, partialAfter);
        const deleted = deleteSelected(block, true);
        if ("response" in deleted) return deleted.response;
        const remaining = selected.slice(partialAfter);
        const remainingTotal = filterQuery
          ? books.filter((book) => matchesListQuery(book, filterQuery)).length
          : undefined;
        return json(
          {
            message: "The selection changed after some books were deleted",
            code: "selection_changed",
            removed: deleted.removed,
            remainingIds: remaining.map((book) => book.id),
            ...(remainingTotal === undefined ? {} : { remainingTotal }),
          },
          409,
        );
      }
      const outcome = deleteSelected(selected, true);
      if ("response" in outcome) return outcome.response;
      return json({
        removed: outcome.removed,
        missing: resolved.missing,
        notesRemoved: outcome.notes,
        ignored: outcome.ignored,
        filesRemoved: selected.filter((book) => !book.source).length,
        fileErrors: 0,
        remaining: filterQuery ? books.filter((book) => matchesListQuery(book, filterQuery)).length : 0,
      });
    }
    if (url.pathname === "/api/ignored-books" && method === "GET") {
      if (!options.facets) return notFound();
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
        return badRequest("Invalid pagination");
      }
      const ordered = [...ignored].reverse();
      return json({
        items: ordered.slice(offset, offset + limit),
        total: ordered.length,
      });
    }
    if (url.pathname === "/api/ignored-books/restore" && method === "POST") {
      if (!options.facets) return notFound();
      const body = bodyOf(init);
      const ids = stringArray(body?.ids, 100);
      if (!ids || ids.length === 0) return badRequest("ids is required");
      const restored = ignored.filter((entry) => ids.includes(entry.id));
      ignored = ignored.filter((entry) => !ids.includes(entry.id));
      for (const entry of restored) {
        if (!entry.managed) books = [restoredBook(entry), ...books];
      }
      return json({ restored: restored.length, scanStarted: true });
    }
    if (url.pathname === "/api/books/facets" && method === "GET") {
      if (!options.facets) return json({ message: "Not found" }, 404);
      const parsed = parseMockQuery(url.searchParams, options);
      if (!parsed.ok) return badRequest(parsed.message);
      return json(computeFacets(books, parsed.query, options.indexing, tags, options.favorites));
    }
    if (url.pathname === "/api/books" && method === "GET") {
      const ids = url.searchParams.get("ids");
      if (ids !== null) {
        const wanted = ids.split(",").filter(Boolean);
        if (wanted.length > 100) return badRequest("Too many ids");
        const found = books.filter((book) => wanted.includes(book.id));
        return json({ items: found, nextCursor: null, total: found.length } satisfies BookPage);
      }
      if (!url.searchParams.has("limit")) {
        const q = (url.searchParams.get("q") ?? "").toLocaleLowerCase();
        return json(
          books.filter(
            (book) => !q || book.title.toLocaleLowerCase().includes(q) || book.author.toLocaleLowerCase().includes(q),
          ),
        );
      }
      const limit = Number(url.searchParams.get("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return badRequest("limit must be between 1 and 200");
      const parsed = parseMockQuery(url.searchParams, options);
      if (!parsed.ok) return badRequest(parsed.message);
      const page = listPage(books, parsed.query, limit, url.searchParams.get("cursor"));
      if ("error" in page) return badRequest(page.error ?? "Invalid cursor");
      return json(page satisfies BookPage);
    }
    if (url.pathname === "/api/books" && method === "POST") return addBook(init);
    if (url.pathname === "/api/scan") {
      return json({ scanning: false, pending: 0, lastScanAt: null });
    }
    if (url.pathname === "/api/index/status") {
      return json({
        enabled: options.indexing,
        search: { semantic: false, embeddings: "none", model: null, state: "off" },
        counts: options.indexing ? indexCounts() : { pending: 0, indexing: 0, ready: 0, error: 0 },
        current: null,
        revision,
        paused,
        rate: null,
        etaSec: null,
        workers: 1,
        vectors: { mode: "auto", maxBooks: 1000 },
      });
    }
    if ((url.pathname === "/api/index/pause" || url.pathname === "/api/index/resume") && method === "POST") {
      paused = url.pathname.endsWith("/pause");
      revision += 1;
      return json({ paused });
    }
    if (url.pathname === "/api/index/enqueue" && method === "POST") {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      const requested = typeof body === "object" && body !== null && "bookIds" in body ? body.bookIds : null;
      if (!Array.isArray(requested) || requested.length === 0) return badRequest("bookIds is required");
      const wanted = new Set(requested.filter((id): id is string => typeof id === "string"));
      let queued = 0;
      let skipped = 0;
      books = books.map((book) => {
        if (!wanted.has(book.id)) return book;
        if (book.status !== "ready") {
          skipped += 1;
          return book;
        }
        queued += 1;
        return { ...book, index: { state: "pending" as const, error: null } };
      });
      revision += 1;
      return json({ queued, skipped }, 202);
    }
    if (url.pathname === "/api/sources") return json(options.facets ? sources() : []);
    if (url.pathname === "/api/chat/status") return json({ enabled: false });
    const cover = url.pathname.match(/^\/api\/books\/([^/]+)\/cover$/);
    if (cover) {
      const book = books.find((item) => item.id === decodeURIComponent(cover[1]!));
      return book?.hasCover ? new Response(ONE_PIXEL_PNG, { headers: { "Content-Type": "image/png" } }) : json({ message: "No cover" }, 404);
    }
    if (url.pathname === "/api/books/__auth-check__") {
      return new Response("[]", { headers: { "Content-Type": "application/json" } });
    }
    const bookNotes = url.pathname.match(/^\/api\/books\/([^/]+)\/notes$/);
    if (bookNotes) {
      if (method !== "GET") return json({ message: "Not found" }, 404);
      const id = decodeURIComponent(bookNotes[1]!);
      const book = books.find((item) => item.id === id);
      if (!book) return notFound();
      return json(mockNotesOf(book));
    }
    const detail = url.pathname.match(/^\/api\/books\/([^/]+)$/);
    if (detail) {
      const id = decodeURIComponent(detail[1]!);
      if (method === "DELETE") {
        const book = books.find((item) => item.id === id);
        if (!book) return notFound();
        const confirmNotes = url.searchParams.get("confirmNotes") === "1";
        const outcome = deleteSelected([book], confirmNotes);
        return "response" in outcome ? outcome.response : new Response(null, { status: 204 });
      }
      const book = books.find((item) => item.id === id);
      return book ? json(mockDetailOf(book)) : json({ message: "Not found" }, 404);
    }
    const progress = url.pathname.match(/^\/api\/books\/([^/]+)\/progress$/);
    if (progress) return json({ message: "No progress" }, 404);
    return json({ message: "Not found" }, 404);
  };
}
