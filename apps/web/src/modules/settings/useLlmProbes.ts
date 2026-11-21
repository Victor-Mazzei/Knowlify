import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, probeMessage, type LlmApi } from "./llmApi";
import { llmProbeDraft, type LlmFieldValues } from "./llmForm";
import type { LlmApiStyle, LlmHeaderRequest, LlmSettingsView } from "./llmTypes";

export type LlmTestFeedback = { tone: "ok" | "warn" | "error"; text: string };
export type LlmBusy = "save" | "reset" | "clearKey" | "test" | "models" | null;

/** Header body for probes: undefined when the draft still matches the saved list. */
export type LlmProbeHeaders = LlmHeaderRequest[] | undefined;

export type LlmProbeGuards = {
  /** Returns a user-facing message when the draft must not be sent. */
  beforeProbe?: () => string | null;
  /** Maps a server 400 to its header row; true means it was handled inline. */
  handleHeaderError?: (reason: unknown) => boolean;
};

const HEADER_REJECTED = "Fix the highlighted custom header and try again.";

/**
 * Connection probes are independent from the saved form: they send only the fields
 * that differ from the effective configuration and report inline feedback. Responses
 * for a draft the user has since edited, or that arrived out of order, are dropped.
 */
export function useLlmProbes(
  client: LlmApi,
  view: LlmSettingsView | null,
  values: LlmFieldValues,
  style: LlmApiStyle,
  headers: LlmProbeHeaders,
  setBusy: (busy: LlmBusy) => void,
  setError: (message: string) => void,
  guards: LlmProbeGuards = {},
) {
  const { beforeProbe, handleHeaderError } = guards;
  const [models, setModels] = useState<string[]>([]);
  const [modelsMessage, setModelsMessage] = useState("");
  const [manualModel, setManualModel] = useState(true);
  const [testFeedback, setTestFeedback] = useState<LlmTestFeedback | null>(null);
  const testId = useRef(0);
  const modelsId = useRef(0);
  const latest = useRef({ values, view, style, headers });
  latest.current = { values, view, style, headers };

  const draftUnchanged = (draftKey: string, kind: "test" | "models") => {
    const current = latest.current;
    return (
      JSON.stringify(
        llmProbeDraft(current.values, current.view, kind, {
          apiStyle: current.style,
          headers: current.headers,
        }),
      ) === draftKey
    );
  };

  useEffect(() => {
    return () => {
      testId.current += 1;
      modelsId.current += 1;
    };
  }, []);

  const test = useCallback(async () => {
    const blocked = beforeProbe?.();
    if (blocked) {
      setTestFeedback({ tone: "error", text: blocked });
      setModelsMessage("");
      setError("");
      return;
    }
    const request = ++testId.current;
    const draft = llmProbeDraft(values, view, "test", { apiStyle: style, headers });
    const draftKey = JSON.stringify(draft);
    setBusy("test");
    setTestFeedback(null);
    setError("");
    try {
      const result = await client.test(draft);
      if (request !== testId.current || !draftUnchanged(draftKey, "test")) return;
      if (result.ok) {
        setTestFeedback({
          tone: result.modelFound === false ? "warn" : "ok",
          text:
            result.modelFound === false
              ? `Connected in ${result.latencyMs} ms. The server did not list this model.`
              : `Connected in ${result.latencyMs} ms.`,
        });
      } else {
        setTestFeedback({ tone: "error", text: probeMessage(result.code, style) });
      }
    } catch (reason: unknown) {
      if (request !== testId.current || !draftUnchanged(draftKey, "test")) return;
      setTestFeedback({
        tone: "error",
        text: handleHeaderError?.(reason) ? HEADER_REJECTED : describeError(reason),
      });
    } finally {
      if (request === testId.current) setBusy(null);
    }
  }, [beforeProbe, client, handleHeaderError, headers, setBusy, setError, style, values, view]);

  const fetchModels = useCallback(async () => {
    const blocked = beforeProbe?.();
    if (blocked) {
      setModelsMessage(blocked);
      setManualModel(true);
      setTestFeedback(null);
      setError("");
      return;
    }
    const request = ++modelsId.current;
    const draft = llmProbeDraft(values, view, "models", { apiStyle: style, headers });
    const draftKey = JSON.stringify(draft);
    setBusy("models");
    setModelsMessage("");
    setError("");
    try {
      const result = await client.models(draft);
      if (request !== modelsId.current || !draftUnchanged(draftKey, "models")) return;
      if (!result.supported) {
        setModels([]);
        setManualModel(true);
        setModelsMessage(
          result.code
            ? probeMessage(result.code, style)
            : "This server does not list models. Enter the model name manually.",
        );
        return;
      }
      setModels(result.models);
      setManualModel(result.models.length === 0);
      setModelsMessage(result.models.length ? "" : "No models were listed. Enter the model name manually.");
    } catch (reason: unknown) {
      if (request !== modelsId.current || !draftUnchanged(draftKey, "models")) return;
      setModelsMessage(handleHeaderError?.(reason) ? HEADER_REJECTED : describeError(reason));
      setManualModel(true);
    } finally {
      if (request === modelsId.current) setBusy(null);
    }
  }, [beforeProbe, client, handleHeaderError, headers, setBusy, setError, style, values, view]);

  const clearTest = useCallback(() => setTestFeedback(null), []);
  const clearModels = useCallback(() => {
    setModels([]);
    setModelsMessage("");
    setManualModel(true);
  }, []);

  return {
    models,
    modelsMessage,
    manualModel,
    setManualModel,
    testFeedback,
    test,
    fetchModels,
    clearTest,
    clearModels,
  };
}
