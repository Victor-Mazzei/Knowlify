import type { ApiFn } from "../../components/dialogs";
import { ApiError, parseApiError, readJson } from "../../services/api";
import type { Note, NoteFeed, NoteGroupsPage } from "./types";

export const NOTE_GROUPS_LIMIT = 20;
export const NOTE_GROUP_NOTES_LIMIT = 5;

const query = (q: string) => q.trim();
const matches = (query: string) => (query ? `?q=${encodeURIComponent(query)}` : "");

/**
 * The groups endpoint is the marker for the grouped notes contract. A server
 * that predates it answers 404 and the page keeps the legacy flat list.
 */
export async function loadNoteFeed(api: ApiFn, q: string, cursor?: string): Promise<NoteFeed> {
  const params = new URLSearchParams({
    limit: String(NOTE_GROUPS_LIMIT),
    perGroup: String(NOTE_GROUP_NOTES_LIMIT),
  });
  if (query(q)) params.set("q", query(q));
  if (cursor) params.set("cursor", cursor);
  try {
    const page = await readJson<NoteGroupsPage>(await api(`/api/notes/groups?${params.toString()}`));
    return { mode: "groups", page };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  return { mode: "legacy", notes: await readJson<Note[]>(await api(`/api/notes${matches(query(q))}`)) };
}

/** All notes of one book that match the active query, in the endpoint's order. */
export async function loadBookNotes(api: ApiFn, bookId: string, q: string): Promise<Note[]> {
  const path = `/api/books/${encodeURIComponent(bookId)}/notes${matches(query(q))}`;
  return readJson<Note[]>(await api(path));
}

export async function deleteNote(api: ApiFn, id: string): Promise<void> {
  const response = await api(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw await parseApiError(response);
}
