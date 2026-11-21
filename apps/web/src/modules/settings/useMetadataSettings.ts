import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoDismiss } from "../../components/useAutoDismiss";
import { ApiError, formatError } from "../../services/api";
import { validateMetadataKey } from "./metadataForm";
import type { MetadataSettingsApi } from "./metadataSettingsApi";
import type { MetadataSettingsView } from "./metadataTypes";

export type MetadataLoadStatus = "loading" | "ready" | "unavailable" | "error";

type Draft = { lookupEnabled: boolean; key: string };
type Busy = "save" | "remove" | null;

const looksLikeKeyProblem = (message: string) => /key/i.test(message);

/** Loads the lookup settings and owns the form draft; saved keys never enter it. */
export function useMetadataSettings(client: MetadataSettingsApi) {
  const [view, setView] = useState<MetadataSettingsView | null>(null);
  const [status, setStatus] = useState<MetadataLoadStatus>("loading");
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft>({ lookupEnabled: true, key: "" });
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [showKey, setShowKey] = useState(false);
  const requestId = useRef(0);
  useAutoDismiss(notice, setNotice);

  const applyView = useCallback((next: MetadataSettingsView) => {
    setView(next);
    setDraft({ lookupEnabled: next.lookupEnabled, key: "" });
    setFieldError("");
    setShowKey(false);
    setStatus("ready");
  }, []);

  const fetchView = useCallback(
    async (mode: "load" | "silent") => {
      const request = ++requestId.current;
      if (mode === "load") {
        setStatus("loading");
        setLoadError("");
      }
      try {
        const next = await client.get();
        if (request !== requestId.current) return null;
        applyView(next);
        return next;
      } catch (reason: unknown) {
        if (request !== requestId.current) return null;
        // Servers older than this contract answer 404: the card keeps the explanatory text.
        if (reason instanceof ApiError && reason.status === 404) {
          setStatus("unavailable");
        } else if (mode === "load") {
          setLoadError(formatError(reason));
          setStatus("error");
        } else {
          setError(formatError(reason));
        }
        return null;
      }
    },
    [applyView, client],
  );

  useEffect(() => {
    void fetchView("load");
    return () => {
      requestId.current += 1;
    };
  }, [fetchView]);

  const setEnabled = useCallback((lookupEnabled: boolean) => {
    setDraft((previous) => ({ ...previous, lookupEnabled }));
    setError("");
    setNotice("");
  }, []);

  const setKey = useCallback((key: string) => {
    setDraft((previous) => ({ ...previous, key }));
    setFieldError("");
    setError("");
    setNotice("");
  }, []);

  const save = useCallback(async () => {
    if (!view) return false;
    if (draft.lookupEnabled === view.lookupEnabled && !draft.key) return false;
    const keyProblem = draft.key ? validateMetadataKey(draft.key) : "";
    if (keyProblem) {
      setFieldError(keyProblem);
      return false;
    }
    setBusy("save");
    setError("");
    setNotice("");
    setFieldError("");
    try {
      const next = await client.save({
        ...(draft.lookupEnabled !== view.lookupEnabled ? { lookupEnabled: draft.lookupEnabled } : {}),
        ...(draft.key ? { googleBooksKey: draft.key } : {}),
      });
      applyView(next);
      setNotice("Saved.");
      return true;
    } catch (reason: unknown) {
      if (reason instanceof ApiError && reason.status === 400) {
        const message = formatError(reason);
        if (looksLikeKeyProblem(message)) setFieldError(message);
        else setError(message);
      } else if (reason instanceof ApiError && reason.status === 403) {
        setError(formatError(reason));
        void fetchView("silent");
      } else {
        setError(formatError(reason));
      }
      return false;
    } finally {
      setBusy(null);
    }
  }, [applyView, client, draft, fetchView, view]);

  const removeKey = useCallback(async () => {
    setBusy("remove");
    setError("");
    setNotice("");
    setFieldError("");
    try {
      const next = await client.save({ googleBooksKey: null });
      applyView(next);
      setNotice("Saved key removed.");
      return true;
    } catch (reason: unknown) {
      if (reason instanceof ApiError && reason.status === 403) {
        setError(formatError(reason));
        void fetchView("silent");
      } else {
        setError(formatError(reason));
      }
      return false;
    } finally {
      setBusy(null);
    }
  }, [applyView, client, fetchView]);

  const dirty =
    view !== null && (draft.lookupEnabled !== view.lookupEnabled || draft.key.length > 0);

  return {
    view,
    status,
    loadError,
    draft,
    fieldError,
    error,
    notice,
    busy,
    showKey,
    dirty,
    setShowKey,
    setEnabled,
    setKey,
    save,
    removeKey,
    reload: () => void fetchView("load"),
  };
}

export type MetadataSettingsState = ReturnType<typeof useMetadataSettings>;
