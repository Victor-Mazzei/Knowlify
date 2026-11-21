import { describe, expect, it } from "vitest";
import { ApiError } from "../../services/api";
import { createMockNoteData, mockNotesApi } from "./mockNotesApi";
import { loadBookNotes, loadNoteFeed } from "./notesApi";

describe("mockNotesApi", () => {
  it("pages groups by books ordered by their latest matching note", async () => {
    const api = mockNotesApi(createMockNoteData({ books: 24, notesPerBook: 6 }));
    const first = await loadNoteFeed(api, "");
    expect(first.mode).toBe("groups");
    if (first.mode !== "groups") return;
    expect(first.page.items).toHaveLength(20);
    expect(first.page.totalBooks).toBe(24);
    expect(first.page.nextCursor).not.toBeNull();
    expect(first.page.items[0]!.book.title).toBe("Quiet Library 1");
    expect(first.page.items[0]!.notes.length).toBe(5);
    expect(first.page.items[0]!.hasMore).toBe(true);
    expect(first.page.items.every((group, index, items) => index === 0 || items[index - 1]!.lastNoteAt >= group.lastNoteAt)).toBe(true);
  });

  it("walks every page without repeating or losing a group", async () => {
    const api = mockNotesApi(createMockNoteData({ books: 24, notesPerBook: 2 }));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const feed = await loadNoteFeed(api, "", cursor);
      if (feed.mode !== "groups") throw new Error("expected groups");
      ids.push(...feed.page.items.map((group) => group.book.id));
      cursor = feed.page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
  });

  it("matches note text and book metadata with q", async () => {
    const api = mockNotesApi(createMockNoteData({ books: 12, notesPerBook: 6 }));
    const byNote = await loadNoteFeed(api, "rhythm");
    if (byNote.mode !== "groups") throw new Error("expected groups");
    expect(byNote.page.totalNotes).toBeGreaterThan(0);
    expect(
      byNote.page.items.every((group) =>
        group.notes.every((note) => `${note.body} ${note.quote} ${note.label}`.toLowerCase().includes("rhythm")),
      ),
    ).toBe(true);

    const byAuthor = await loadNoteFeed(api, "Ada Meridian");
    if (byAuthor.mode !== "groups") throw new Error("expected groups");
    expect(byAuthor.page.items).toHaveLength(3);
    expect(byAuthor.page.items.every((group) => group.book.author === "Ada Meridian")).toBe(true);
    expect(byAuthor.page.items[0]!.noteCount).toBe(6);
  });

  it("filters the notes of one book and deletes a note", async () => {
    const api = mockNotesApi(createMockNoteData({ books: 2, notesPerBook: 6 }));
    const rhythm = await loadBookNotes(api, "note-book-00001", "rhythm");
    expect(rhythm).toHaveLength(1);
    expect(rhythm[0]!.body).toContain("rhythm");

    const response = await api("/api/notes/note-1-1", { method: "DELETE" });
    expect(response.status).toBe(204);
    const all = await loadBookNotes(api, "note-book-00001", "");
    expect(all.some((note) => note.id === "note-1-1")).toBe(false);
  });

  it("answers 404 for groups in legacy mode and keeps the flat notes endpoint", async () => {
    const api = mockNotesApi(createMockNoteData({ books: 4, notesPerBook: 2 }), { legacy: true });
    const feed = await loadNoteFeed(api, "");
    expect(feed.mode).toBe("legacy");
    if (feed.mode !== "legacy") return;
    expect(feed.notes.length).toBeGreaterThan(0);
    expect(feed.notes.every((note) => typeof note.bookTitle === "string")).toBe(true);
  });

  it("rejects an invalid groups cursor", async () => {
    const api = mockNotesApi();
    const response = await api("/api/notes/groups?cursor=broken");
    await expect(response.json()).resolves.toEqual({ message: "Invalid cursor" });
    expect(response.status).toBe(400);
    await expect(loadNoteFeed(api, "anything", "broken")).rejects.toBeInstanceOf(ApiError);
  });
});
