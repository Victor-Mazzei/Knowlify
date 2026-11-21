import { describe, expect, it } from "vitest";
import {
  addHeaderRow,
  emptyHeaderRow,
  headerErrorTarget,
  headerRowsFrom,
  headersChanged,
  headersRequest,
  needsNewHeaderValues,
  removeHeaderRow,
  updateHeaderRow,
  validateHeaderRows,
  type LlmHeaderRow,
} from "./llmHeaders";
import type { LlmSettingsView } from "./llmTypes";

const view = (overrides: Partial<LlmSettingsView> = {}): LlmSettingsView => ({
  source: "db",
  locked: false,
  enabled: true,
  url: "https://api.example.com/v1",
  model: "model",
  hasKey: true,
  keyState: "set",
  maxTokens: 1024,
  timeoutSec: 120,
  ratePerMin: 20,
  defaults: { maxTokens: 1024, timeoutSec: 120, ratePerMin: 20 },
  policy: { allowPrivate: "off", publicRequiresHttps: true },
  prompt: {
    custom: null,
    default: "Prompt",
    version: "feynman-2",
    maxChars: 4000,
    locked: false,
  },
  apiStyle: "openai",
  headers: [{ name: "x-session-id", hasValue: true }],
  headersState: "set",
  ...overrides,
});

const savedRow = (): LlmHeaderRow => ({
  id: "row-1",
  name: "x-session-id",
  value: "",
  hadValue: true,
});

const messages = (overrides: Partial<LlmSettingsView>, rows: LlmHeaderRow[], url = view().url ?? "") =>
  validateHeaderRows(rows, view(overrides), url).issues.map((issue) => issue.message);

describe("llmHeaders", () => {
  it("turns saved names into blank rows and does not keep unreadable values", () => {
    const rows = headerRowsFrom(view());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "x-session-id", value: "", hadValue: true });

    const unreadable = headerRowsFrom(view({ headersState: "unreadable" }));
    expect(unreadable[0].hadValue).toBe(false);
  });

  it("validates names, values, duplicates, forbidden headers and templates", () => {
    const invalidName = { ...emptyHeaderRow(), name: "Bad Name", value: "v" };
    expect(messages({ headers: [], headersState: "none" }, [invalidName])).toEqual([
      "Use 1–64 letters, digits, or token symbols.",
    ]);

    const forbidden = { ...emptyHeaderRow(), name: "Host", value: "v" };
    expect(messages({ headers: [], headersState: "none" }, [forbidden])[0]).toContain("Host");

    const duplicate = [
      { ...emptyHeaderRow(), name: "x-trace", value: "a" },
      { ...emptyHeaderRow(), name: "X-Trace", value: "b" },
    ];
    expect(messages({ headers: [], headersState: "none" }, duplicate)[0]).toBe("“X-Trace” is already used.");

    const control = { ...emptyHeaderRow(), name: "x-trace", value: "bad\nvalue" };
    expect(messages({ headers: [], headersState: "none" }, [control])[0]).toContain("visible ASCII");

    const template = { ...emptyHeaderRow(), name: "x-trace", value: "{{other}}" };
    expect(messages({ headers: [], headersState: "none" }, [template])[0]).toBe(
      "Use {{conversationId}} as the only variable.",
    );

    const known = { ...emptyHeaderRow(), name: "x-trace", value: "{{conversationId}}" };
    expect(messages({ headers: [], headersState: "none" }, [known])).toEqual([]);
  });

  it("rejects every Accept* header in both styles", () => {
    for (const name of ["Accept", "Accept-Encoding", "Accept-Language", "accept-charset"]) {
      const row = { ...emptyHeaderRow(), name, value: "en" };
      for (const style of ["openai", "anthropic"] as const) {
        const result = validateHeaderRows([row], view({ headers: [] }), view().url ?? "", style);
        expect(result.issues[0]?.message ?? "").toContain("managed by Knowlify");
      }
    }
  });

  it("validates the original value before trimming control characters at the edges", () => {
    for (const value of ["\r\nsecret", "secret\r\n", "sec\tret", "secret\u007f"]) {
      const row = { ...emptyHeaderRow(), name: "x-trace", value };
      expect(messages({ headers: [], headersState: "none" }, [row])[0]).toContain("visible ASCII");
    }

    const padded = { ...emptyHeaderRow(), name: "x-trace", value: "  secret  " };
    expect(messages({ headers: [], headersState: "none" }, [padded])).toEqual([]);
    expect(headersRequest([padded], view({ headers: [], headersState: "none" }), view().url ?? "")).toEqual([
      { name: "x-trace", value: "secret" },
    ]);
  });

  it("treats a control-only edit of a kept value as a changed draft", () => {
    const rows = updateHeaderRow([savedRow()], "row-1", "value", "\r\n");
    expect(headersChanged(rows, view())).toBe(true);
    expect(validateHeaderRows(rows, view(), view().url ?? "").issues[0].message).toContain("visible ASCII");
  });

  it("rejects x-api-key only in the Anthropic style", () => {
    const row = { ...emptyHeaderRow(), name: "x-api-key", value: "secret" };
    const openai = validateHeaderRows([row], view({ headers: [] }), "https://api.example.com/v1", "openai");
    const anthropic = validateHeaderRows([row], view({ headers: [] }), "https://api.example.com/v1", "anthropic");
    expect(openai.issues).toEqual([]);
    expect(anthropic.issues[0].message).toContain("Anthropic API style");
  });

  it("keeps an unchanged saved value and treats a rename as a new value", () => {
    const row = savedRow();
    expect(validateHeaderRows([row], view(), view().url ?? "").issues).toEqual([]);
    expect(headersChanged([row], view())).toBe(false);
    expect(headersRequest([row], view(), view().url ?? "")).toBeUndefined();

    const renamed = updateHeaderRow([row], row.id, "name", "x-renamed");
    expect(validateHeaderRows(renamed, view(), view().url ?? "").issues[0].field).toBe("value");
    expect(headersChanged(renamed, view())).toBe(true);

    const filled = updateHeaderRow(renamed, row.id, "value", "new-value");
    expect(headersRequest(filled, view(), view().url ?? "")).toEqual([
      { name: "x-renamed", value: "new-value" },
    ]);
  });

  it("requires saved values again when the server origin changes", () => {
    const row = savedRow();
    const other = "https://other.example/v1";
    expect(needsNewHeaderValues([row], view(), other)).toBe(true);
    expect(validateHeaderRows([row], view(), other).issues[0].message).toContain("changed origin");

    const filled = updateHeaderRow([row], row.id, "value", "secret");
    expect(needsNewHeaderValues(filled, view(), other)).toBe(false);
    expect(headersRequest(filled, view(), other)).toEqual([{ name: "x-session-id", value: "secret" }]);
  });

  it("clears headers when every saved row is removed", () => {
    const row = savedRow();
    const removed = removeHeaderRow([row], row.id);
    expect(headersChanged(removed, view())).toBe(true);
    expect(headersRequest(removed, view(), view().url ?? "")).toEqual([]);
  });

  it("adds rows up to the limit and ignores blank rows", () => {
    let rows: LlmHeaderRow[] = [];
    for (let index = 0; index < 10; index += 1) rows = addHeaderRow(rows);
    expect(rows).toHaveLength(8);
    expect(headersChanged(rows, view({ headers: [], headersState: "none" }))).toBe(false);
    expect(validateHeaderRows(rows, view({ headers: [], headersState: "none" }), view().url ?? "").issues).toEqual([]);
  });

  it("reports oversized drafts and maps server errors to rows", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...emptyHeaderRow(),
      name: `x-long-${index}`,
      value: "a".repeat(500),
    }));
    const result = validateHeaderRows(rows, view({ headers: [], headersState: "none" }), view().url ?? "");
    expect(result.formError).toContain("too large");

    expect(headerErrorTarget([savedRow()], 'The header "x-session-id" needs a value.', "header_value_required")).toEqual({
      rowId: "row-1",
      field: "value",
    });
    expect(headerErrorTarget([savedRow()], 'The header "missing" is invalid.', "invalid_header")).toBeNull();
  });

  it("uses the field reported by the server and falls back for older servers", () => {
    const rows: LlmHeaderRow[] = [
      { id: "value-row", name: "X-Test", value: "new", hadValue: false },
      { id: "name-row", name: "X-Other", value: "secret", hadValue: false },
    ];
    const invalidValue = "The value of the header “X-Test” is not valid";

    expect(headerErrorTarget(rows, invalidValue, "invalid_header", "value")).toEqual({
      rowId: "value-row",
      field: "value",
    });
    expect(headerErrorTarget(rows, "The header “X-Other” is managed by Knowlify.", "invalid_header", "name")).toEqual({
      rowId: "name-row",
      field: "name",
    });
    expect(headerErrorTarget(rows, "A value is required for the header “X-Test”", "header_value_required", "value")).toEqual({
      rowId: "value-row",
      field: "value",
    });

    // Servers from before the field was added only send the code.
    expect(headerErrorTarget(rows, invalidValue, "invalid_header")).toEqual({
      rowId: "value-row",
      field: "name",
    });
    expect(headerErrorTarget(rows, "A value is required for the header “X-Test”", "header_value_required")).toEqual({
      rowId: "value-row",
      field: "value",
    });

    // Anything outside the contract is ignored instead of trusted.
    expect(headerErrorTarget(rows, invalidValue, "invalid_header", "other")).toEqual({
      rowId: "value-row",
      field: "name",
    });
    expect(headerErrorTarget(rows, invalidValue, "invalid_header", null)).toEqual({
      rowId: "value-row",
      field: "name",
    });
  });
});
