import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { deleteNote, loadBookNotes, loadNoteFeed } from "./notesApi";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const note = {
  id: "n1",
  bookId: "b1",
  bookTitle: "Book",
  location: "",
  label: "",
  quote: "",
  body: "text",
  createdAt: 1,
  updatedAt: 2,
};

describe("notesApi", () => {
  it("falls back to the legacy endpoint when groups answers 404", async () => {
    const api = vi.fn<ApiFn>(async (path) =>
      path.startsWith("/api/notes/groups") ? json({ message: "Not found" }, 404) : json([note]),
    );
    const feed = await loadNoteFeed(api, "alpha ");
    expect(feed).toEqual({ mode: "legacy", notes: [note] });
    expect(api.mock.calls[1]?.[0]).toBe("/api/notes?q=alpha");
  });

  it("does not hide a groups failure other than 404", async () => {
    const api = vi.fn<ApiFn>(async () => json({ message: "Broken" }, 500));
    await expect(loadNoteFeed(api, "")).rejects.toMatchObject({ status: 500 });
  });

  it("adds q to the book notes request only when searching", async () => {
    const api = vi.fn<ApiFn>(async () => json([note]));
    await loadBookNotes(api, "book/1", " alpha ");
    await loadBookNotes(api, "book/1", "");
    expect(api.mock.calls[0]?.[0]).toBe("/api/books/book%2F1/notes?q=alpha");
    expect(api.mock.calls[1]?.[0]).toBe("/api/books/book%2F1/notes");
  });

  it("throws the parsed error when a delete fails", async () => {
    const api = vi.fn<ApiFn>(async () => json({ message: "Locked" }, 500));
    await expect(deleteNote(api, "n1")).rejects.toBeInstanceOf(ApiError);
    await expect(deleteNote(api, "n1")).rejects.toMatchObject({ message: "Locked", status: 500 });
  });
});
