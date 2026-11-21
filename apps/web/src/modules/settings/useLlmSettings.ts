import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoDismiss } from "../../components/useAutoDismiss";
import { ApiError } from "../../services/api";
import { describeError, type LlmApi } from "./llmApi";
import {
  llmFieldId,
  needsNewKey,
  validateLlmValues,
  valuesFrom,
  type LlmField,
  type LlmFieldErrors,
  type LlmFieldValues,
} from "./llmForm";
import { headerFieldId } from "./llmHeaders";
import type { LlmApiStyle, LlmSaveRequest, LlmSettingsView } from "./llmTypes";
import { useLlmHeadersDraft } from "./useLlmHeadersDraft";
import { useLlmProbes, type LlmBusy } from "./useLlmProbes";

const FIELDS: LlmField[] = ["url", "model", "apiKey", "maxTokens", "timeoutSec", "ratePerMin"];
const ADVANCED_FIELDS: LlmField[] = ["maxTokens", "timeoutSec", "ratePerMin"];

/**
 * The API only exposes a message for 400s. Key errors mention the URL
 * ("An API key is required for this server URL"), so they must win over the URL match.
 */
const looksLikeKeyProblem = (message: string) => /api key/i.test(message);
const looksLikeUrlProblem = (message: string) => /url|address|https|private/i.test(message);
const isHeaderProblem = (reason: unknown): reason is ApiError =>
  reason instanceof ApiError &&
  reason.status === 400 &&
  (reason.code === "invalid_header" || reason.code === "header_value_required");

export function useLlmSettings(client: LlmApi, onChanged?: () => void) {
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [values, setValues] = useState<LlmFieldValues>(() => valuesFrom(null));
  const [errors, setErrors] = useState<LlmFieldErrors>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<LlmBusy>(null);
  const [showKey, setShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const loadId = useRef(0);
  const headers = useLlmHeadersDraft();
  const {
    reset: resetHeaders,
    request: requestHeaders,
    changed: headersChanged,
    selectStyle: selectHeaderStyle,
    validate: validateHeaders,
    applyServerError,
  } = headers;
  const headerBody = requestHeaders(view, values.url);

  const guardProbe = useCallback((): string | null => {
    if (headerBody === undefined) return null;
    const result = validateHeaders(view, values.url);
    if (!result.issues.length && !result.formError) return null;
    const first = result.issues[0];
    if (first) setFocusId(headerFieldId(first.rowId, first.field));
    return "Fix the custom headers first.";
  }, [headerBody, validateHeaders, values.url, view]);

  const handleProbeHeaderError = useCallback(
    (reason: unknown): boolean => {
      if (!isHeaderProblem(reason)) return false;
      const target = applyServerError(reason.message, reason.code, reason.details?.field);
      if (!target) return false;
      setFocusId(headerFieldId(target.rowId, target.field));
      return true;
    },
    [applyServerError],
  );

  const probes = useLlmProbes(
    client,
    view,
    values,
    headers.style,
    headerBody,
    setBusy,
    setError,
    { beforeProbe: guardProbe, handleHeaderError: handleProbeHeaderError },
  );
  useAutoDismiss(notice, setNotice);

  const applyView = useCallback(
    (next: LlmSettingsView) => {
      setView(next);
      setValues(valuesFrom(next));
      setErrors({});
      setShowKey(false);
      resetHeaders(next);
    },
    [resetHeaders],
  );

  const fetchView = useCallback(
    async (mode: "load" | "silent") => {
      const request = ++loadId.current;
      if (mode === "load") setLoading(true);
      setLoadError("");
      setError("");
      try {
        const next = await client.get();
        if (request !== loadId.current) return null;
        applyView(next);
        return next;
      } catch (reason: unknown) {
        if (request !== loadId.current) return null;
        if (mode === "load") setLoadError(describeError(reason));
        else setError(describeError(reason));
        return null;
      } finally {
        if (request === loadId.current && mode === "load") setLoading(false);
      }
    },
    [applyView, client],
  );

  useEffect(() => {
    void fetchView("load");
    return () => {
      loadId.current += 1;
    };
  }, [fetchView]);

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId, advancedOpen, headers.open]);

  const setValue = useCallback((field: LlmField, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => {
      if (!previous[field]) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
    setError("");
    setNotice("");
  }, []);

  const discard = useCallback(() => {
    if (!view) return;
    applyView(view);
    setError("");
    setNotice("");
    probes.clearTest();
  }, [applyView, probes, view]);

  const setStyle = useCallback(
    (next: LlmApiStyle) => {
      if (!view) return;
      selectHeaderStyle(next, view, values.url);
      probes.clearModels();
      probes.clearTest();
      setError("");
      setNotice("");
    },
    [probes, selectHeaderStyle, values.url, view],
  );

  const save = useCallback(async () => {
    if (!view) return;
    const problems = validateLlmValues(values, view);
    const headerCheck = validateHeaders(view, values.url);
    const firstHeader = headerCheck.issues[0];
    if (Object.keys(problems).length || firstHeader || headerCheck.formError) {
      setErrors(problems);
      setError("");
      const first = FIELDS.find((field) => problems[field]);
      if (first) {
        if (ADVANCED_FIELDS.includes(first)) setAdvancedOpen(true);
        setFocusId(llmFieldId(first));
      } else if (firstHeader) {
        setFocusId(headerFieldId(firstHeader.rowId, firstHeader.field));
      }
      return;
    }
    setErrors({});
    setError("");
    setNotice("");
    setBusy("save");
    try {
      const styleChanged = view.apiStyle !== undefined && headers.style !== view.apiStyle;
      const body: LlmSaveRequest = {
        url: values.url.trim(),
        model: values.model.trim() || null,
        maxTokens: Number(values.maxTokens),
        timeoutSec: Number(values.timeoutSec),
        ratePerMin: Number(values.ratePerMin),
        ...(values.apiKey ? { apiKey: values.apiKey } : {}),
        ...(styleChanged ? { apiStyle: headers.style } : {}),
        ...(headerBody !== undefined ? { headers: headerBody } : {}),
      };
      const updated = await client.save(body);
      if (updated.url !== view.url) probes.clearModels();
      // The connection endpoint does not own the persona; keep the persona and prompt draft.
      applyView({ ...updated, prompt: view.prompt });
      probes.clearTest();
      setNotice(updated.enabled ? "Saved. The assistant is ready." : "Saved.");
      onChanged?.();
    } catch (reason: unknown) {
      const message = describeError(reason);
      if (isHeaderProblem(reason)) {
        const target = applyServerError(reason.message, reason.code, reason.details?.field);
        if (target) setFocusId(headerFieldId(target.rowId, target.field));
      } else if (reason instanceof ApiError && reason.status === 400 && looksLikeKeyProblem(message)) {
        setErrors({ apiKey: message });
        setFocusId(llmFieldId("apiKey"));
      } else if (reason instanceof ApiError && reason.status === 400 && looksLikeUrlProblem(message)) {
        setErrors({ url: message });
        setFocusId(llmFieldId("url"));
      } else {
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  }, [applyServerError, applyView, client, headerBody, headers.style, onChanged, probes, values, view]);

  const reset = useCallback(async () => {
    setBusy("reset");
    setError("");
    setNotice("");
    try {
      await client.reset();
      const next = await fetchView("silent");
      if (next) {
        probes.clearModels();
        probes.clearTest();
        setNotice(next.source === "env" ? "Reset. Using the server environment." : "Reset. No provider is configured.");
        onChanged?.();
      }
    } catch (reason: unknown) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  }, [client, fetchView, onChanged, probes]);

  const clearKey = useCallback(async () => {
    setBusy("clearKey");
    setError("");
    setNotice("");
    try {
      await client.clearKey();
      const next = await fetchView("silent");
      if (next) {
        probes.clearTest();
        setNotice("Saved API key removed.");
        onChanged?.();
      }
    } catch (reason: unknown) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  }, [client, fetchView, onChanged, probes]);

  const dirty = useMemo(() => {
    if (!view) return false;
    const original = valuesFrom(view);
    const styleChanged = view.apiStyle !== undefined && headers.style !== view.apiStyle;
    return FIELDS.some((field) => values[field] !== original[field]) || styleChanged || headersChanged(view);
  }, [values, view, headers.style, headersChanged]);

  const reload = useCallback(() => void fetchView("load"), [fetchView]);

  return {
    view,
    values,
    errors,
    loading,
    loadError,
    error,
    notice,
    busy,
    showKey,
    setShowKey,
    advancedOpen,
    setAdvancedOpen,
    dirty,
    keyRequired: view ? needsNewKey(values, view) : false,
    setValue,
    discard,
    setStyle,
    save,
    reset,
    clearKey,
    reload,
    headers,
    ...probes,
  };
}

export type LlmSettingsState = ReturnType<typeof useLlmSettings>;
