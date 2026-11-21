import type { ApiFn } from "../../components/dialogs";
import { parseApiError, readJson } from "../../services/api";
import type { BookSelection, Tag, TagColor, TagWithCount } from "../../types";
import { isTagColor } from "./tagColors";

export type TagApplyResult = { matched: number; added: number; removed: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTag = (value: unknown): value is Tag =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  isTagColor(value.color) &&
  (typeof value.createdAt === "number" || typeof value.createdAt === "string");

const withCount = (value: unknown): value is TagWithCount =>
  isTag(value) && typeof (value as { count?: unknown }).count === "number";

/** Tags are small and bounded (200); one request fills the cache. */
export async function listTags(api: ApiFn): Promise<TagWithCount[]> {
  const payload = await readJson<{ items?: unknown }>(await api("/api/tags"));
  const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
  return items.filter(withCount);
}

export async function createTag(api: ApiFn, input: { name: string; color?: TagColor }): Promise<Tag> {
  const response = await api("/api/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const tag: unknown = await readJson(response);
  if (!isTag(tag)) throw new Error("The server returned an unexpected tag.");
  return tag;
}

export async function updateTag(
  api: ApiFn,
  id: string,
  change: { name?: string; color?: TagColor },
): Promise<Tag> {
  const response = await api(`/api/tags/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  const tag: unknown = await readJson(response);
  if (!isTag(tag)) throw new Error("The server returned an unexpected tag.");
  return tag;
}

export async function deleteTag(api: ApiFn, id: string): Promise<void> {
  const response = await api(`/api/tags/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw await parseApiError(response);
}

export async function applyTags(
  api: ApiFn,
  body: { selection: BookSelection; add?: string[]; remove?: string[] },
): Promise<TagApplyResult> {
  const response = await api("/api/books/tags", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson<Partial<TagApplyResult>>(response);
  return {
    matched: typeof payload.matched === "number" ? payload.matched : 0,
    added: typeof payload.added === "number" ? payload.added : 0,
    removed: typeof payload.removed === "number" ? payload.removed : 0,
  };
}

/** Message the UI shows for a failed tag mutation; keeps server codes meaningful. */
export function tagErrorMessage(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "tag_name_taken") return "A tag with this name already exists.";
    if (code === "tag_limit_reached") return "You already have the maximum of 200 tags.";
    if (code === "book_tag_limit") return "A book cannot have more than 50 tags.";
    if (code === "tag_not_found") return "That tag no longer exists. Refresh and try again.";
    if (code === "selection_changed") return "The selection changed. Review the books and try again.";
    if (code === "selection_too_large") return "This selection is too large. Narrow the filters and try again.";
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
