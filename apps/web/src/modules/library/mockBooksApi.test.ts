import { describe, expect, it } from "vitest";
import type { Book, BookFacets, BookPage, DeleteDryRun, DeleteResult, IgnoredBook, Tag, TagWithCount } from "../../types";
import { createMockBooks, mockBooksApi } from "./mockBooksApi";
import { sourceIdOf } from "./mockBooksQuery";

const read = async <T>(response: Response) => (await response.json()) as T;

const library: Book[] = [
  {
    id: "b1",
    title: "Alpha",
    author: "Zed",
    format: "pdf",
    size: 1,
    addedAt: 100,
    hasCover: false,
    status: "ready",
    source: true,
    index: { state: "ready", error: null },
    progress: { percentage: 0.5, updatedAt: 100 },
  },
  {
    id: "b2",
    title: "Bravo",
    author: "Amy",
    format: "epub",
    size: 1,
    addedAt: 200,
    hasCover: false,
    status: "ready",
    source: false,
    index: { state: "pending", error: null },
    progress: { percentage: 0.995, updatedAt: 200 },
  },
  {
    id: "b3",
    title: "Charlie",
    author: "Bob",
    format: "pdf",
    size: 1,
    addedAt: 300,
    hasCover: false,
    status: "ready",
    source: true,
    index: { state: "error", error: { code: "unknown", message: "broken" } },
    progress: null,
  },
  {
    id: "b20",
    title: "Delta",
    author: "Cat",
    format: "epub",
    size: 1,
    addedAt: 400,
    hasCover: false,
    status: "ready",
    source: false,
    index: { state: "ready", error: null },
    progress: { percentage: 0.001, updatedAt: 300 },
  },
];


describe("mockBooksApi", () => {
  it("pages through 11,000 books without repeating or dropping an id", async () => {
    const api = mockBooksApi(createMockBooks());
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string = `/api/books?limit=200&sort=added&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: BookPage = await read<BookPage>(await api(path));
      expect(page.total).toBe(11_000);
      for (const book of page.items) {
        expect(seen.has(book.id)).toBe(false);
        seen.add(book.id);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 100);
    expect(pages).toBe(55);
    expect(seen.size).toBe(11_000);
  });

  it("filters by query and keeps the total of matching books", async () => {
    const api = mockBooksApi(createMockBooks({ count: 500 }));
    const page = await read<BookPage>(await api("/api/books?limit=20&q=Author%2012"));
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.every((book) => book.author === "Author 12")).toBe(true);
  });

  it("sorts by title ascending", async () => {
    const api = mockBooksApi(createMockBooks({ count: 200 }));
    const page = await read<BookPage>(await api("/api/books?limit=200&sort=title&order=asc"));
    const titles = page.items.map((book) => book.title.toLocaleLowerCase());
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  it("answers the ids lookup and the legacy array shape", async () => {
    const books = createMockBooks({ count: 10 });
    const api = mockBooksApi(books);
    const lookup = await read<BookPage>(await api(`/api/books?ids=${books[2]!.id},${books[5]!.id},missing`));
    expect(lookup.items.map((book) => book.id)).toEqual([books[2]!.id, books[5]!.id]);
    expect(lookup.total).toBe(2);

    const legacy = await read<Book[]>(await api("/api/books"));
    expect(legacy).toHaveLength(10);
  });

  it("rejects an invalid limit and a cursor from another query", async () => {
    const api = mockBooksApi(createMockBooks({ count: 120 }));
    expect((await api("/api/books?limit=0")).status).toBe(400);
    const first = await read<BookPage>(await api("/api/books?limit=10"));
    expect((await api(`/api/books?limit=10&q=other&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
  });

  it("exposes disjunctive facets", async () => {
    const api = mockBooksApi(library);
    const data = await read<BookFacets>(await api("/api/books/facets"));
    expect(data).toEqual({
      total: 4,
      format: { pdf: 2, epub: 2 },
      read: { unread: 2, reading: 1, finished: 1 },
      index: { ready: 2, pending: 1, error: 1 },
      source: [
        { id: "source-1", count: 0 },
        { id: "source-2", count: 2 },
        { id: "upload", count: 2 },
      ],
      notes: { with: 1 },
      favorite: { with: 0 },
      tag: [
        { id: "tag-favorites", count: 1 },
        { id: "tag-read-later", count: 1 },
        { id: "tag-research", count: 1 },
      ],
    });
  });

  it("ignores each dimension's own filter in the facet counts", async () => {
    const api = mockBooksApi(library);
    const data = await read<BookFacets>(await api("/api/books/facets?read=reading"));
    expect(data.total).toBe(1);
    expect(data.format).toEqual({ pdf: 1, epub: 0 });
    expect(data.read).toEqual({ unread: 2, reading: 1, finished: 1 });
    expect(data.index).toEqual({ ready: 1, pending: 0, error: 0 });
    expect(data.source).toEqual([
      { id: "source-1", count: 0 },
      { id: "source-2", count: 1 },
      { id: "upload", count: 0 },
    ]);
    expect(data.notes).toEqual({ with: 0 });
    expect(data.tag).toEqual([
      { id: "tag-favorites", count: 0 },
      { id: "tag-read-later", count: 0 },
      { id: "tag-research", count: 0 },
    ]);
  });

  it("applies filters to the list and keeps the total in sync with facets", async () => {
    const api = mockBooksApi(library);
    const unread = await read<BookPage>(await api("/api/books?limit=10&read=unread&sort=title&order=asc"));
    expect(unread.total).toBe(2);
    expect(unread.items.map((book) => book.id)).toEqual(["b3", "b20"]);

    const pdfReading = await read<BookPage>(await api("/api/books?limit=10&format=pdf&read=reading"));
    expect(pdfReading.items.map((book) => book.id)).toEqual(["b1"]);

    const notes = await read<BookPage>(await api("/api/books?limit=10&notes=1"));
    expect(notes.items.map((book) => book.id)).toEqual(["b20"]);

    const upload = await read<BookPage>(await api("/api/books?limit=10&source=upload"));
    expect(upload.total).toBe(2);
    expect(upload.items.map((book) => book.id).sort()).toEqual(["b2", "b20"]);

    const facets = await read<BookFacets>(await api("/api/books/facets?read=unread"));
    expect(facets.total).toBe(unread.total);
  });

  it("sorts by last read (only books with progress) and by author", async () => {
    const api = mockBooksApi(library);
    const lastRead = await read<BookPage>(await api("/api/books?limit=10&sort=lastRead&order=desc"));
    expect(lastRead.total).toBe(3);
    expect(lastRead.items.map((book) => book.id)).toEqual(["b20", "b2", "b1"]);

    const author = await read<BookPage>(await api("/api/books?limit=10&sort=author&order=asc"));
    expect(author.total).toBe(4);
    expect(author.items.map((book) => book.author)).toEqual(["Amy", "Bob", "Cat", "Zed"]);
  });

  it("sorts in-reading books first by last read, then the rest by added", async () => {
    const api = mockBooksApi(library);
    const first = await read<BookPage>(await api("/api/books?limit=2&sort=reading"));
    expect(first.total).toBe(4);
    expect(first.items.map((book) => book.id)).toEqual(["b1", "b20"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await read<BookPage>(
      await api(`/api/books?limit=2&sort=reading&cursor=${encodeURIComponent(first.nextCursor!)}`),
    );
    expect(second.items.map((book) => book.id)).toEqual(["b3", "b2"]);
    expect(second.nextCursor).toBeNull();
    expect((await api("/api/books?limit=10&sort=reading&order=asc")).status).toBe(400);
  });

  it("rejects invalid filter values and a stale v1 cursor", async () => {
    const api = mockBooksApi(library);
    expect((await api("/api/books?limit=10&read=unknown")).status).toBe(400);
    expect((await api("/api/books?limit=10&notes=yes")).status).toBe(400);
    expect((await api("/api/books?limit=10&format=pdf,epub")).status).toBe(400);
    expect((await api("/api/books?limit=10&source=bad%20id")).status).toBe(400);
    const manySources = Array.from({ length: 11 }, (_, index) => `s${index}`).join(",");
    expect((await api(`/api/books?limit=10&source=${manySources}`)).status).toBe(400);

    const v1 = btoa(JSON.stringify({ v: 1, sort: "added", order: "desc", q: "", format: "", value: 10, id: "b1" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect((await api(`/api/books?limit=10&cursor=${encodeURIComponent(v1)}`)).status).toBe(400);
    expect((await api("/api/books?limit=10&cursor=nonsense")).status).toBe(400);
  });

  it("rejects a cursor issued for another filter set", async () => {
    const api = mockBooksApi(library);
    const first = await read<BookPage>(await api("/api/books?limit=1&read=unread"));
    expect(first.nextCursor).toBeTruthy();
    const response = await api(`/api/books?limit=1&read=reading&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(response.status).toBe(400);
  });

  it("reports index as null and rejects index filters when indexing is disabled", async () => {
    const api = mockBooksApi(library, { indexing: false });
    const data = await read<BookFacets>(await api("/api/books/facets"));
    expect(data.index).toBeNull();
    expect((await api("/api/books?limit=10&index=error")).status).toBe(400);
    expect((await api("/api/books/facets?index=error")).status).toBe(400);
  });

  it("simulates an older server: no facets and no new filter support", async () => {
    const api = mockBooksApi(library, { facets: false });
    expect((await api("/api/books/facets")).status).toBe(404);
    const page = await read<BookPage>(await api("/api/books?limit=10&read=unread&sort=title&order=asc"));
    expect(page.total).toBe(4);
    expect((await api("/api/books?limit=10&sort=lastRead")).status).toBe(400);
    expect(await read<unknown>(await api("/api/sources"))).toEqual([]);
  });

  it("keeps source filter matching tied to the synthetic source ids", () => {
    expect(sourceIdOf(library[0]!)).toBe("source-2");
    expect(sourceIdOf(library[1]!)).toBe("upload");
    expect(sourceIdOf(library[3]!)).toBe("upload");
  });

  it("lists tags with global counts and filters books by tag", async () => {
    const api = mockBooksApi(library);
    const list = await read<{ items: TagWithCount[] }>(await api("/api/tags"));
    expect(list.items.map((entry) => entry.name)).toEqual(["Favorites", "Read later", "Research"]);
    expect(list.items.map((entry) => entry.count)).toEqual([1, 1, 1]);

    const tagged = await read<BookPage>(await api("/api/books?limit=10&tag=tag-favorites"));
    expect(tagged.items.map((book) => book.id)).toEqual(["b3"]);
    expect(tagged.items[0]?.tagIds).toContain("tag-favorites");
    expect((await api("/api/books?limit=10&tag=bad%20id")).status).toBe(400);
  });

  it("counts tags disjunctively in the facets", async () => {
    const api = mockBooksApi(library);
    const facets = await read<BookFacets>(await api("/api/books/facets?tag=tag-favorites&format=pdf"));
    expect(facets.tag).toEqual([
      { id: "tag-favorites", count: 1 },
      { id: "tag-read-later", count: 0 },
      { id: "tag-research", count: 0 },
    ]);
  });

  it("toggles single favorites, batches by ids or filter and rejects a changed filter", async () => {
    const api = mockBooksApi(library);
    expect(await read(await api("/api/books/b1/favorite", { method: "PUT" }))).toEqual({ favorite: true });
    expect(await read(await api("/api/books/b1/favorite", { method: "PUT" }))).toEqual({ favorite: true });
    expect((await api("/api/books/missing/favorite", { method: "PUT" })).status).toBe(404);

    const explicit = await api("/api/books/favorite", {
      method: "PATCH",
      body: JSON.stringify({ ids: ["b2", "b3"], favorite: true }),
    });
    expect(await read(explicit)).toEqual({ updated: 2 });

    const favorites = await read<BookPage>(await api("/api/books?limit=10&favorite=1"));
    expect(favorites.items.map((book) => book.id).sort()).toEqual(["b1", "b2", "b3"]);
    expect((await read<BookFacets>(await api("/api/books/facets"))).favorite).toEqual({ with: 3 });

    const changed = await api("/api/books/favorite", {
      method: "PATCH",
      body: JSON.stringify({ filter: { favorite: "1" }, expectedTotal: 99, favorite: false }),
    });
    expect(changed.status).toBe(409);
    expect(await read<{ code: string }>(changed)).toMatchObject({ code: "selection_changed" });

    const filtered = await api("/api/books/favorite", {
      method: "PATCH",
      body: JSON.stringify({ filter: { favorite: "1" }, expectedTotal: 3, favorite: false }),
    });
    expect(await read(filtered)).toEqual({ updated: 3 });
    expect((await read<BookFacets>(await api("/api/books/facets"))).favorite).toEqual({ with: 0 });
    expect((await api("/api/books?limit=10&favorite=2")).status).toBe(400);
  });

  it("hides favorites on a tags-era server", async () => {
    const api = mockBooksApi(library, { favorites: false });
    const data = await read<BookFacets>(await api("/api/books/facets"));
    expect(data.favorite).toBeUndefined();
    expect((await api("/api/books/b1/favorite", { method: "PUT" })).status).toBe(404);
  });

  it("creates, renames and deletes tags, removing associations on delete", async () => {
    const api = mockBooksApi(library);
    const created = await read<Tag>(
      await api("/api/tags", { method: "POST", body: JSON.stringify({ name: "  Deep   Work ", color: "violet" }) }),
    );
    expect(created).toMatchObject({ name: "Deep Work", color: "violet" });
    expect((await api("/api/tags", { method: "POST", body: JSON.stringify({ name: "deep work" }) })).status).toBe(409);

    const renamed = await read<Tag>(
      await api(`/api/tags/${created.id}`, { method: "PATCH", body: JSON.stringify({ name: "DEEP WORK" }) }),
    );
    expect(renamed.name).toBe("DEEP WORK");
    expect(
      (await api("/api/tags/tag-favorites", { method: "PATCH", body: JSON.stringify({ name: "DEEP WORK" }) })).status,
    ).toBe(409);

    expect((await api("/api/tags/tag-favorites", { method: "DELETE" })).status).toBe(204);
    const lookup = await read<BookPage>(await api("/api/books?ids=b3"));
    expect(lookup.items[0]?.tagIds).not.toContain("tag-favorites");
  });

  it("applies tags to explicit ids and to a filtered selection", async () => {
    const api = mockBooksApi(library);
    const byIds = await read<{ matched: number; added: number }>(
      await api("/api/books/tags", {
        method: "PATCH",
        body: JSON.stringify({ selection: { ids: ["b1", "missing"] }, add: ["tag-favorites"] }),
      }),
    );
    expect(byIds).toMatchObject({ matched: 1, added: 1 });
    expect((await api("/api/books/tags", {
      method: "PATCH",
      body: JSON.stringify({ selection: { ids: ["b1"] }, add: ["tag-favorites"] }),
    })).status).toBe(200);

    const byFilter = await read<{ matched: number; added: number }>(
      await api("/api/books/tags", {
        method: "PATCH",
        body: JSON.stringify({ selection: { filter: { format: "pdf" }, expectedTotal: 2 }, add: ["tag-research"] }),
      }),
    );
    expect(byFilter).toMatchObject({ matched: 2, added: 2 });

    const stale = await api("/api/books/tags", {
      method: "PATCH",
      body: JSON.stringify({ selection: { filter: { format: "pdf" }, expectedTotal: 1 }, add: ["tag-research"] }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("selection_changed");
    expect((await api("/api/books/tags", {
      method: "PATCH",
      body: JSON.stringify({ selection: { ids: ["b1"] }, add: ["tag-missing"] }),
    })).status).toBe(404);
    expect((await api("/api/books/tags", {
      method: "PATCH",
      body: JSON.stringify({ selection: { ids: ["b1"] }, add: ["tag-research"], remove: ["tag-research"] }),
    })).status).toBe(400);
  });

  it("serves no tags routes on an older server", async () => {
    const api = mockBooksApi(library, { facets: false });
    expect((await api("/api/tags")).status).toBe(404);
    expect((await api("/api/books/tags", { method: "PATCH", body: "{}" })).status).toBe(404);
  });

  it("reviews deletion with a dry run, requires notes confirmation and lists ignored books", async () => {
    const api = mockBooksApi(library);
    const dry = await read<DeleteDryRun>(
      await api("/api/books/delete", {
        method: "POST",
        body: JSON.stringify({ selection: { ids: ["b1", "b20", "missing"] }, dryRun: true }),
      }),
    );
    expect(dry).toEqual({
      books: 2,
      notes: 1,
      conversations: 0,
      withProgress: 2,
      indexed: 2,
      managedFiles: 1,
      externalBooks: 1,
      wouldIgnore: 1,
    });

    const blocked = await api("/api/books/delete", {
      method: "POST",
      body: JSON.stringify({ selection: { ids: ["b1", "b20"] } }),
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe("notes_confirmation_required");
    expect((await read<BookPage>(await api("/api/books?ids=b1,b20"))).total).toBe(2);

    const result = await read<DeleteResult>(
      await api("/api/books/delete", {
        method: "POST",
        body: JSON.stringify({ selection: { ids: ["b1", "b20"] }, confirmNotes: true }),
      }),
    );
    expect(result).toMatchObject({ removed: 2, missing: 0, notesRemoved: 1, ignored: 1, filesRemoved: 1, remaining: 0 });
    expect((await read<BookPage>(await api("/api/books?ids=b1,b20"))).total).toBe(0);

    const ignored = await read<{ items: IgnoredBook[]; total: number }>(await api("/api/ignored-books"));
    // The upload has no known folder alias, so only the folder book gets a tombstone.
    expect(ignored.total).toBe(1);
    expect(ignored.items[0]).toMatchObject({ managed: false, reason: "path" });

    const restored = await read<{ restored: number; scanStarted: boolean }>(
      await api("/api/ignored-books/restore", { method: "POST", body: JSON.stringify({ ids: [ignored.items[0]!.id] }) }),
    );
    expect(restored).toEqual({ restored: 1, scanStarted: true });
    expect((await read<{ total: number }>(await api("/api/ignored-books"))).total).toBe(0);
  });

  it("reports a partial deletion when a note blocks a later block", async () => {
    const api = mockBooksApi(library, { partialDeleteAfter: 1 });
    const partial = await api("/api/books/delete", {
      method: "POST",
      body: JSON.stringify({ selection: { ids: ["b1", "b2", "b3"] }, confirmNotes: true }),
    });
    expect(partial.status).toBe(409);
    expect(await partial.json()).toMatchObject({ code: "selection_changed", removed: 1, remainingIds: ["b2", "b3"] });
    expect((await read<BookPage>(await api("/api/books?ids=b1,b2,b3"))).total).toBe(2);

    const result = await read<DeleteResult>(
      await api("/api/books/delete", {
        method: "POST",
        body: JSON.stringify({ selection: { ids: ["b2", "b3"] }, confirmNotes: true }),
      }),
    );
    expect(result).toMatchObject({ removed: 2, missing: 0, remaining: 0 });
    expect((await read<BookPage>(await api("/api/books?ids=b1,b2,b3"))).total).toBe(0);
  });

  it("reports remainingTotal for a filtered partial deletion", async () => {
    const api = mockBooksApi(library, { partialDeleteAfter: 1 });
    const partial = await api("/api/books/delete", {
      method: "POST",
      body: JSON.stringify({
        selection: { filter: { format: "pdf" }, expectedTotal: 2 },
        confirmNotes: true,
      }),
    });
    expect(await partial.json()).toMatchObject({
      code: "selection_changed",
      removed: 1,
      remainingTotal: 1,
    });

    const retried = await api("/api/books/delete", {
      method: "POST",
      body: JSON.stringify({
        selection: { filter: { format: "pdf" }, expectedTotal: 1 },
        confirmNotes: true,
      }),
    });
    expect(await retried.json()).toMatchObject({ removed: 1, remaining: 0 });
  });

  it("counts missing ids like the server instead of dropping them silently", async () => {
    const api = mockBooksApi(library);
    const result = await read<DeleteResult>(
      await api("/api/books/delete", {
        method: "POST",
        body: JSON.stringify({ selection: { ids: ["b1", "missing"] } }),
      }),
    );
    expect(result).toMatchObject({ removed: 1, missing: 1 });
  });

  it("enforces the server selection ceilings", async () => {
    const api = mockBooksApi(library);
    const tooManyBooks = await api("/api/books/delete", {
      method: "POST",
      body: JSON.stringify({
        selection: { ids: Array.from({ length: 101 }, (_, index) => `missing-${index}`) },
        dryRun: true,
      }),
    });
    expect(tooManyBooks.status).toBe(400);

    const tooManyForTags = await api("/api/books/tags", {
      method: "PATCH",
      body: JSON.stringify({
        selection: { ids: Array.from({ length: 201 }, (_, index) => `missing-${index}`) },
        add: ["tag-favorites"],
      }),
    });
    expect(tooManyForTags.status).toBe(400);
  });

  it("also guards the single delete route with confirmNotes", async () => {
    const api = mockBooksApi(library);
    expect((await api("/api/books/b20", { method: "DELETE" })).status).toBe(409);
    expect((await api("/api/books/b20", { method: "DELETE" })).status).toBe(409);
    expect((await api("/api/books/b20?confirmNotes=1", { method: "DELETE" })).status).toBe(204);
    expect((await api("/api/books/b20")).status).toBe(404);
  });

  it("serves no ignored routes on an older server", async () => {
    const api = mockBooksApi(library, { facets: false });
    expect((await api("/api/ignored-books")).status).toBe(404);
    expect((await api("/api/books/delete", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
