import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoDismiss } from "../../components/useAutoDismiss";
import { ApiError, formatError } from "../../services/api";
import type { ChatLimitsApi, ChatLimitsView } from "./chatLimitsApi";

type Busy = "save" | "default" | null;

/** Loads the session limit and owns the numeric draft; the card only renders it. */
export function useChatLimits(client: ChatLimitsApi, onChanged?: () => void) {
  const [view, setView] = useState<ChatLimitsView | null>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const requestId = useRef(0);
  useAutoDismiss(notice, setNotice);

  const applyView = useCallback((next: ChatLimitsView) => {
    setView(next);
    setValue(String(next.maxConversations));
    setFieldError("");
  }, []);

  const fetchView = useCallback(
    async (mode: "load" | "silent") => {
      const request = ++requestId.current;
      if (mode === "load") {
        setLoading(true);
        setLoadError("");
      }
      try {
        const next = await client.get();
        if (request !== requestId.current) return null;
        applyView(next);
        return next;
      } catch (reason) {
        if (request !== requestId.current) return null;
        if (mode === "load") setLoadError(formatError(reason));
        else setError(formatError(reason));
        return null;
      } finally {
        if (request === requestId.current && mode === "load") setLoading(false);
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

  const change = useCallback((next: string) => {
    setValue(next);
    setFieldError("");
    setError("");
    setNotice("");
  }, []);

  const validate = useCallback((): number | null => {
    if (!view) return null;
    const text = value.trim();
    const parsed = Number(text);
    if (!/^\d+$/.test(text) || !Number.isInteger(parsed) || parsed < view.min || parsed > view.max) {
      setFieldError(`Enter a whole number from ${view.min} to ${view.max}.`);
      return null;
    }
    return parsed;
  }, [value, view]);

  const save = useCallback(async () => {
    if (!view || view.locked) return;
    const next = validate();
    if (next === null) return;
    setBusy("save");
    setError("");
    setNotice("");
    setFieldError("");
    try {
      const updated = await client.save(next);
      applyView(updated);
      setNotice("Saved. The new limit applies right away.");
      onChanged?.();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 400) {
        setFieldError(formatError(reason));
      } else if (reason instanceof ApiError && reason.status === 403) {
        setError(formatError(reason));
        void fetchView("silent");
      } else {
        setError(formatError(reason));
      }
    } finally {
      setBusy(null);
    }
  }, [applyView, client, fetchView, onChanged, validate, view]);

  const useDefault = useCallback(async () => {
    if (!view || view.locked) return;
    setBusy("default");
    setError("");
    setNotice("");
    setFieldError("");
    try {
      const updated = await client.save(null);
      applyView(updated);
      setNotice(updated.source === "env" ? "Using the server environment." : "Using the default limit.");
      onChanged?.();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 403) {
        setError(formatError(reason));
        void fetchView("silent");
      } else {
        setError(formatError(reason));
      }
    } finally {
      setBusy(null);
    }
  }, [applyView, client, fetchView, onChanged, view]);

  // Saving the same number still matters when the value comes from env/default: it stores an override.
  const dirty =
    view !== null &&
    (value.trim() !== String(view.maxConversations) || view.source !== "db");

  return {
    view,
    value,
    loading,
    loadError,
    fieldError,
    error,
    notice,
    busy,
    dirty,
    setValue: change,
    save,
    useDefault,
    reload: () => void fetchView("load"),
  };
}

export type ChatLimitsState = ReturnType<typeof useChatLimits>;
