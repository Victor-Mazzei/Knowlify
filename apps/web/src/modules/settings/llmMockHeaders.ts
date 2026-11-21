import { ApiError } from "../../services/api";
import { validateHeaderRows, type LlmHeaderField, type LlmHeaderRow } from "./llmHeaders";
import type { LlmApiStyle, LlmHeaderView } from "./llmTypes";
import type { MockView, SavedHeader } from "./llmMockViews";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Mirrors the server body: `{message, code, field}`; `field` points at the failing input. */
const fail = (
  status: number,
  message: string,
  code?: string,
  field?: LlmHeaderField,
): never => {
  const details: Record<string, unknown> = { message };
  if (code !== undefined) details.code = code;
  if (field !== undefined) details.field = field;
  throw new ApiError(status, message, code, details);
};

export const originOf = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

export const sameOrigin = (a: string | null | undefined, b: string | null | undefined) => {
  const left = originOf(a);
  return left !== null && left === originOf(b);
};

export const readApiStyle = (
  body: Record<string, unknown> | null,
  fallback: LlmApiStyle,
): LlmApiStyle => {
  if (!body || body.apiStyle === undefined) return fallback;
  const value = body.apiStyle;
  if (value !== "openai" && value !== "anthropic") {
    return fail(400, "The API style must be openai or anthropic.");
  }
  return value;
};

const requestRows = (
  items: unknown,
  current: MockView,
  draftUrl: string,
): LlmHeaderRow[] => {
  if (!Array.isArray(items)) return fail(400, "headers must be an array.", "invalid_header", "name");
  const list: unknown[] = items;
  const keepOrigin = sameOrigin(draftUrl, current.url) && current.headersState !== "unreadable";
  const saved = new Set((current.headers ?? []).map((header) => header.name.toLowerCase()));
  return list.map((item, index) => {
    if (!isRecord(item) || typeof item.name !== "string") {
      return fail(400, "Each header needs a name.", "invalid_header", "name");
    }
    if (item.value !== undefined && typeof item.value !== "string") {
      return fail(400, `The header “${item.name}” has an invalid value.`, "invalid_header", "value");
    }
    const name = item.name;
    return {
      id: `mock-${index}`,
      name,
      value: item.value ?? "",
      hadValue: keepOrigin && saved.has(name.trim().toLowerCase()),
    };
  });
};

/** Validate the draft, then resolve kept values into the next saved list. */
export const applyHeaderRequest = (
  current: MockView,
  currentValues: Map<string, SavedHeader>,
  items: unknown,
  draftUrl: string,
  style: LlmApiStyle,
): Map<string, SavedHeader> => {
  const rows = requestRows(items, current, draftUrl);
  const result = validateHeaderRows(rows, current, draftUrl, style);
  const missingValue = result.issues.find(
    (issue) =>
      issue.field === "value" &&
      issue.message.startsWith("Enter ") &&
      !rows.find((row) => row.id === issue.rowId)?.value.trim(),
  );
  if (missingValue) {
    const row = rows.find((item) => item.id === missingValue.rowId);
    fail(
      400,
      `The header “${row?.name.trim() ?? ""}” needs a value.`,
      "header_value_required",
      "value",
    );
  }
  if (result.issues.length) {
    fail(400, result.issues[0].message, "invalid_header", result.issues[0].field);
  }
  if (result.formError) fail(400, result.formError, "invalid_header", "name");

  const keepOrigin = sameOrigin(draftUrl, current.url);
  const next = new Map<string, SavedHeader>();
  for (const row of rows) {
    const name = row.name.trim();
    const key = name.toLowerCase();
    const value = row.value.trim();
    if (value) {
      next.set(key, { name, value });
    } else if (row.hadValue && keepOrigin) {
      const saved = currentValues.get(key);
      next.set(key, saved ?? { name, value: "" });
    }
  }
  return next;
};

/**
 * The provider can gain new rules when the style changes; revalidate the effective
 * names so a stored `x-api-key` cannot survive a switch to Anthropic.
 */
export const assertHeadersAllowed = (
  headers: LlmHeaderView[],
  current: MockView,
  draftUrl: string,
  style: LlmApiStyle,
) => {
  const nextView: MockView = {
    ...current,
    url: draftUrl,
    headers,
    headersState: headers.length ? "set" : "none",
  };
  const rows: LlmHeaderRow[] = headers.map((header, index) => ({
    id: `mock-final-${index}`,
    name: header.name,
    // Stored values are not available for an unreadable blob; the actual values
    // were already validated when the request carried them. This pass checks names.
    value: "x",
    hadValue: true,
  }));
  const result = validateHeaderRows(rows, nextView, draftUrl, style);
  if (result.issues.length) {
    fail(400, result.issues[0].message, "invalid_header", result.issues[0].field);
  }
  if (result.formError) fail(400, result.formError, "invalid_header", "name");
};
