import type { ApiFn } from "../../components/dialogs";
import { parseApiError, readJson } from "../../services/api";
import type { Format, IgnoredBook } from "../../types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isIgnoredBook = (value: unknown): value is IgnoredBook =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.title === "string" &&
  typeof value.size === "number" &&
  typeof value.managed === "boolean" &&
  (typeof value.ignoredAt === "number" || typeof value.ignoredAt === "string") &&
  ["path", "content", "both"].includes(String(value.reason));

export const IGNORED_PAGE_SIZE = 50;

export async function listIgnored(
  api: ApiFn,
  offset: number,
): Promise<{ items: IgnoredBook[]; total: number }> {
  const response = await api(`/api/ignored-books?limit=${IGNORED_PAGE_SIZE}&offset=${offset}`);
  const payload = await readJson<{ items?: unknown; total?: unknown }>(response);
  const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items.filter(isIgnoredBook) : [];
  const total = isRecord(payload) && typeof payload.total === "number" ? payload.total : items.length;
  return { items, total };
}

export async function restoreIgnored(api: ApiFn, ids: string[]): Promise<{ restored: number; scanStarted: boolean }> {
  const response = await api("/api/ignored-books/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw await parseApiError(response);
  const payload = (await response.json()) as { restored?: unknown; scanStarted?: unknown };
  return {
    restored: typeof payload.restored === "number" ? payload.restored : ids.length,
    scanStarted: payload.scanStarted === true,
  };
}

export function ignoredReasonLabel(reason: IgnoredBook["reason"]): string {
  if (reason === "both") return "by path and content";
  return reason === "path" ? "by path" : "by content";
}

export const ignoredFormat = (format: Format) => format.toUpperCase();
