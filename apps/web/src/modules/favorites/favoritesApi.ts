import type { ApiFn } from "../../components/dialogs";
import { readJson } from "../../services/api";
import type { BookSelection } from "../../types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const favoritePath = (bookId: string) => `/api/books/${encodeURIComponent(bookId)}/favorite`;

function readFavorite(value: unknown): boolean {
  if (!isRecord(value) || typeof value.favorite !== "boolean") {
    throw new Error("The server returned an unexpected favorite state.");
  }
  return value.favorite;
}

/**
 * `PUT` favorites a book and `DELETE` unfavorites it; both are idempotent and return the
 * stored state. A missing book is a 404 (`ApiError`).
 */
export async function setBookFavorite(
  api: ApiFn,
  bookId: string,
  favorite: boolean,
): Promise<boolean> {
  const response = await api(favoritePath(bookId), { method: favorite ? "PUT" : "DELETE" });
  return readFavorite(await readJson(response));
}

/**
 * `PATCH /api/books/favorite` — bulk toggle for an explicit selection or filter. The
 * body carries `ids`/`filter` and `expectedTotal` at the top level (the plan's frozen
 * contract), not the `selection` envelope used by the tags endpoint.
 */
export async function setBookFavorites(
  api: ApiFn,
  selection: BookSelection,
  favorite: boolean,
): Promise<number> {
  const response = await api("/api/books/favorite", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...selection, favorite }),
  });
  const payload = await readJson<unknown>(response);
  if (!isRecord(payload) || typeof payload.updated !== "number") {
    throw new Error("The server returned an unexpected favorite update.");
  }
  return payload.updated;
}

/** Keeps the 409 codes actionable without exposing server internals. */
export function favoriteErrorMessage(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "selection_changed") return "The selection changed. Review the books and try again.";
    if (code === "selection_too_large") return "This selection is too large. Narrow the filters and try again.";
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
