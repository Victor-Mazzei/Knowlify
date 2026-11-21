import { useCallback, useState } from "react";
import {
  addHeaderRow,
  headerErrorTarget,
  headerRowCount,
  headerRowsFrom,
  headersChanged,
  headersRequest,
  needsNewHeaderValues,
  removeHeaderRow,
  styleOf,
  updateHeaderRow,
  validateHeaderRows,
  type LlmHeaderError,
  type LlmHeaderField,
  type LlmHeaderRow,
  type LlmHeaderValidation,
} from "./llmHeaders";
import type { LlmApiStyle, LlmSettingsView } from "./llmTypes";

export type LlmHeaderErrors = Record<string, LlmHeaderError>;

/** Draft state for the connection's API style and custom headers. */
export function useLlmHeadersDraft() {
  const [style, setStyleState] = useState<LlmApiStyle>("openai");
  const [rows, setRows] = useState<LlmHeaderRow[]>([]);
  const [errors, setErrors] = useState<LlmHeaderErrors>({});
  const [formError, setFormError] = useState("");
  const [open, setOpen] = useState(false);
  const [showValues, setShowValues] = useState(false);

  const reset = useCallback((view: LlmSettingsView | null) => {
    setStyleState(styleOf(view));
    setRows(headerRowsFrom(view));
    setErrors({});
    setFormError("");
    setOpen(false);
    setShowValues(false);
  }, []);

  const update = useCallback((id: string, field: LlmHeaderField, value: string) => {
    setRows((previous) => updateHeaderRow(previous, id, field, value));
    setErrors((previous) => {
      if (!previous[id]) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
    setFormError("");
  }, []);

  const add = useCallback(() => {
    setRows((previous) => addHeaderRow(previous));
    setOpen(true);
  }, []);

  const remove = useCallback((id: string) => {
    setRows((previous) => removeHeaderRow(previous, id));
    setErrors((previous) => {
      if (!previous[id]) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
    setFormError("");
  }, []);

  const selectStyle = useCallback(
    (next: LlmApiStyle, view: LlmSettingsView | null, url: string) => {
      setStyleState(next);
      const result = validateHeaderRows(rows, view, url, next);
      setErrors(result.errors);
      setFormError(result.formError);
      if (result.issues.length || result.formError) setOpen(true);
    },
    [rows],
  );

  const validate = useCallback(
    (view: LlmSettingsView | null, url: string): LlmHeaderValidation => {
      const result = validateHeaderRows(rows, view, url, style);
      setErrors(result.errors);
      setFormError(result.formError);
      if (result.issues.length || result.formError) setOpen(true);
      return result;
    },
    [rows, style],
  );

  const applyServerError = useCallback(
    (message: string, code?: string, field?: unknown) => {
      const target = headerErrorTarget(rows, message, code, field);
      if (target) {
        setErrors((previous) => ({
          ...previous,
          [target.rowId]: { field: target.field, message },
        }));
      } else {
        setFormError(message);
      }
      setOpen(true);
      return target;
    },
    [rows],
  );

  const changed = useCallback(
    (view: LlmSettingsView | null) => headersChanged(rows, view),
    [rows],
  );

  const request = useCallback(
    (view: LlmSettingsView | null, url: string) => headersRequest(rows, view, url),
    [rows],
  );

  const needsValues = useCallback(
    (view: LlmSettingsView | null, url: string) => needsNewHeaderValues(rows, view, url),
    [rows],
  );

  return {
    style,
    rows,
    errors,
    formError,
    open,
    showValues,
    setOpen,
    setShowValues,
    reset,
    update,
    add,
    remove,
    selectStyle,
    validate,
    applyServerError,
    changed,
    request,
    needsValues,
    count: headerRowCount(rows),
  };
}

export type LlmHeadersDraft = ReturnType<typeof useLlmHeadersDraft>;
