import { managedHeaderReason } from "./llmStyles";
import type {
  LlmApiStyle,
  LlmHeaderRequest,
  LlmSettingsView,
} from "./llmTypes";

export const LLM_HEADER_LIMIT = 8;
export const LLM_HEADER_NAME_MAX = 64;
export const LLM_HEADER_VALUE_MAX = 512;
export const LLM_HEADER_TOTAL_MAX = 3072;
export const LLM_CONVERSATION_VARIABLE = "{{conversationId}}";

const NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HAS_INVALID_VALUE_CHAR = /[^\x20-\x7e]/;

/** True when the raw value contains a control character or non-ASCII text. */
export const hasInvalidHeaderValueChars = (value: string): boolean =>
  HAS_INVALID_VALUE_CHAR.test(value);

export type LlmHeaderRow = {
  /** Stable for focus management while the draft lives. */
  id: string;
  name: string;
  value: string;
  /** A value is stored on the server and can be kept by leaving the field blank. */
  hadValue: boolean;
};

export type LlmHeaderField = "name" | "value";
export type LlmHeaderError = { field: LlmHeaderField; message: string };
export type LlmHeaderIssue = LlmHeaderError & { rowId: string };
export type LlmHeaderValidation = {
  issues: LlmHeaderIssue[];
  errors: Record<string, LlmHeaderError>;
  formError: string;
};

let headerRowSeq = 0;
const nextRowId = () => `h${(headerRowSeq += 1)}`;

export const headerFieldId = (rowId: string, field: LlmHeaderField) => `llm-header-${rowId}-${field}`;

export const styleOf = (view: LlmSettingsView | null): LlmApiStyle => view?.apiStyle ?? "openai";

const originOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const sameOrigin = (url: string, savedUrl: string | null | undefined): boolean => {
  const before = originOf(savedUrl);
  return before !== null && before === originOf(url);
};

const savedNames = (view: LlmSettingsView | null): Set<string> =>
  new Set((view?.headers ?? []).map((header) => header.name.toLowerCase()));

const activeRows = (rows: LlmHeaderRow[]): LlmHeaderRow[] =>
  rows.filter((row) => row.name.trim() || row.value.trim() || row.hadValue);

const hasTemplateProblem = (value: string) => {
  const withoutKnown = value.split(LLM_CONVERSATION_VARIABLE).join("");
  return withoutKnown.includes("{{") || withoutKnown.includes("}}");
};

export function headerRowsFrom(view: LlmSettingsView | null): LlmHeaderRow[] {
  const canKeep = view?.headersState !== "unreadable";
  return (view?.headers ?? []).map((header) => ({
    id: nextRowId(),
    name: header.name,
    value: "",
    hadValue: canKeep && header.hasValue,
  }));
}

export const emptyHeaderRow = (): LlmHeaderRow => ({ id: nextRowId(), name: "", value: "", hadValue: false });

export function addHeaderRow(rows: LlmHeaderRow[]): LlmHeaderRow[] {
  return rows.length >= LLM_HEADER_LIMIT ? rows : [...rows, emptyHeaderRow()];
}

export function removeHeaderRow(rows: LlmHeaderRow[], id: string): LlmHeaderRow[] {
  return rows.filter((row) => row.id !== id);
}

export function updateHeaderRow(
  rows: LlmHeaderRow[],
  id: string,
  field: LlmHeaderField,
  value: string,
): LlmHeaderRow[] {
  return rows.map((row) => (row.id === id ? { ...row, [field]: value } : row));
}

export const headerRowCount = (rows: LlmHeaderRow[]): number => activeRows(rows).length;

/** True when a saved value could be kept: same name and same saved origin. */
export function needsNewHeaderValues(
  rows: LlmHeaderRow[],
  view: LlmSettingsView | null,
  url: string,
): boolean {
  const saved = savedNames(view);
  if (!saved.size || sameOrigin(url, view?.url)) return false;
  return rows.some((row) => row.hadValue && saved.has(row.name.trim().toLowerCase()) && !row.value.trim());
}

export function validateHeaderRows(
  rows: LlmHeaderRow[],
  view: LlmSettingsView | null,
  url: string,
  style: LlmApiStyle = styleOf(view),
): LlmHeaderValidation {
  const issues: LlmHeaderIssue[] = [];
  let formError = "";
  const active = activeRows(rows);
  if (active.length > LLM_HEADER_LIMIT) {
    return {
      issues,
      errors: {},
      formError: `Use at most ${LLM_HEADER_LIMIT} custom headers.`,
    };
  }

  const saved = savedNames(view);
  const keepOrigin = sameOrigin(url, view?.url);
  const seen = new Set<string>();
  let total = 0;

  for (const row of active) {
    const name = row.name.trim();
    const rawValue = row.value;
    const value = rawValue.trim();
    total += name.length + value.length;
    const lower = name.toLowerCase();

    let problem: LlmHeaderError | null = null;
    const reason = name ? managedHeaderReason(name, style) : null;
    if (!name) {
      problem = { field: "name", message: "Enter a header name." };
    } else if (name.length > LLM_HEADER_NAME_MAX || !NAME_TOKEN.test(name)) {
      problem = {
        field: "name",
        message: `Use 1–${LLM_HEADER_NAME_MAX} letters, digits, or token symbols.`,
      };
    } else if (reason) {
      problem = {
        field: "name",
        message: `“${name}” ${reason}.`,
      };
    } else if (seen.has(lower)) {
      problem = { field: "name", message: `“${name}” is already used.` };
    }
    seen.add(lower);

    if (!problem) {
      // Validate the original text before trimming: a line break or tab at the
      // edges is still a control character and must never reach the server.
      if (hasInvalidHeaderValueChars(rawValue)) {
        problem = {
          field: "value",
          message: "Use visible ASCII characters only; line breaks, tabs and controls are not allowed.",
        };
      } else if (!value) {
        const canKeep = row.hadValue && saved.has(lower) && keepOrigin;
        if (!canKeep) {
          problem = {
            field: "value",
            message:
              row.hadValue && saved.has(lower)
                ? "Enter the value again because the server URL changed origin."
                : "Enter a value.",
          };
        }
      } else if (value.length > LLM_HEADER_VALUE_MAX) {
        problem = {
          field: "value",
          message: `Use at most ${LLM_HEADER_VALUE_MAX} visible ASCII characters.`,
        };
      } else if (hasTemplateProblem(value)) {
        problem = {
          field: "value",
          message: "Use {{conversationId}} as the only variable.",
        };
      }
    }

    if (problem) issues.push({ rowId: row.id, ...problem });
  }

  if (total > LLM_HEADER_TOTAL_MAX) {
    formError = "Custom headers are too large. Shorten the names or values.";
  }

  const errors: Record<string, LlmHeaderError> = {};
  for (const issue of issues) {
    if (!errors[issue.rowId]) {
      errors[issue.rowId] = { field: issue.field, message: issue.message };
    }
  }

  return { issues, errors, formError };
}

/** Compares the draft with the saved view, ignoring blank, never-saved rows. */
export function headersChanged(rows: LlmHeaderRow[], view: LlmSettingsView | null): boolean {
  if (!view?.headers) return false;
  const active = activeRows(rows);
  const saved = view.headers.map((header) => header.name);
  const valueChanged = (row: LlmHeaderRow) =>
    Boolean(row.value.trim()) || hasInvalidHeaderValueChars(row.value);

  if (view.headersState === "unreadable") {
    if (active.length !== saved.length) return true;
    return active.some(
      (row, index) => row.name.trim() !== saved[index] || valueChanged(row),
    );
  }

  if (active.length !== saved.length) return true;
  return active.some(
    (row, index) =>
      !row.hadValue || row.name.trim() !== saved[index] || valueChanged(row),
  );
}

/**
 * The `headers` body for save/probes. Undefined means "unchanged"; an empty array
 * clears the saved list. Values are sent only for new or replaced entries.
 */
export function headersRequest(
  rows: LlmHeaderRow[],
  view: LlmSettingsView | null,
  url: string,
): LlmHeaderRequest[] | undefined {
  if (!headersChanged(rows, view)) return undefined;
  const saved = savedNames(view);
  const keepOrigin = sameOrigin(url, view?.url);
  return activeRows(rows).map((row) => {
    const name = row.name.trim();
    const keep = row.hadValue && keepOrigin && saved.has(name.toLowerCase()) && !row.value.trim();
    return keep ? { name } : { name, value: row.value.trim() };
  });
}

/** Narrows the untrusted `field` of a server error body to a focusable input. */
const headerErrorField = (value: unknown): LlmHeaderField | undefined =>
  value === "name" || value === "value" ? value : undefined;

/** Maps a server error to the row it names so the message can stay inline. */
export function headerErrorTarget(
  rows: LlmHeaderRow[],
  message: string,
  code?: string,
  field?: unknown,
): { rowId: string; field: LlmHeaderField } | null {
  const quoted = /“([^”]+)”|"([^"]+)"/.exec(message);
  const named = quoted?.[1] ?? quoted?.[2];
  const lowerMessage = message.toLowerCase();
  const row = named
    ? rows.find((item) => item.name.trim().toLowerCase() === named.toLowerCase())
    : rows.find(
        (item) => item.name.trim() && lowerMessage.includes(item.name.trim().toLowerCase()),
      );
  if (!row) return null;
  // Current servers report which input failed; older ones only sent the code.
  const reported = headerErrorField(field);
  return {
    rowId: row.id,
    field: reported ?? (code === "header_value_required" ? "value" : "name"),
  };
}
