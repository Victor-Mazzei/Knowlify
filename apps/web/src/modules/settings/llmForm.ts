import {
  LLM_DEFAULT_LIMITS,
  LLM_LIMITS,
  type LlmApiStyle,
  type LlmHeaderRequest,
  type LlmProbeRequest,
  type LlmSettingsView,
} from "./llmTypes";

export type LlmField = "url" | "model" | "apiKey" | "maxTokens" | "timeoutSec" | "ratePerMin";

export type LlmFieldErrors = Partial<Record<LlmField, string>>;
export type LlmFieldValues = Record<LlmField, string>;

export const llmFieldId = (field: LlmField) => (field === "apiKey" ? "llm-api-key" : `llm-${field}`);

export const valuesFrom = (view: LlmSettingsView | null): LlmFieldValues => ({
  url: view?.url ?? "",
  model: view?.model ?? "",
  apiKey: "",
  maxTokens: String(view?.maxTokens ?? LLM_DEFAULT_LIMITS.maxTokens),
  timeoutSec: String(view?.timeoutSec ?? LLM_DEFAULT_LIMITS.timeoutSec),
  ratePerMin: String(view?.ratePerMin ?? LLM_DEFAULT_LIMITS.ratePerMin),
});

const safeOrigin = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** The server key is never sent to a different origin; the form must ask for a new one. */
export const needsNewKey = (values: LlmFieldValues, view: LlmSettingsView): boolean => {
  if (!view.hasKey || !view.url) return false;
  const before = safeOrigin(view.url);
  const after = safeOrigin(values.url.trim());
  return Boolean(before && after && before !== after && !values.apiKey);
};

export type LlmProbeExtras = {
  apiStyle?: LlmApiStyle;
  /** Present only when the header draft differs from the saved configuration. */
  headers?: LlmHeaderRequest[];
};

/**
 * Probes only carry fields that differ from the effective configuration. Sending an
 * untouched URL would turn an environment endpoint into a user draft (subject to the
 * SSRF policy) and any draft is rejected while the server is locked. An empty model
 * cannot be expressed as a probe draft, so it falls back to the effective model.
 */
export function llmProbeDraft(
  values: LlmFieldValues,
  view: LlmSettingsView | null,
  kind: "test" | "models",
  extras: LlmProbeExtras = {},
): LlmProbeRequest {
  const draft: LlmProbeRequest = {};
  if (!view || view.locked) return draft;
  const url = values.url.trim();
  if (url !== (view.url ?? "")) draft.url = url;
  if (values.apiKey) draft.apiKey = values.apiKey;
  if (kind === "test") {
    const model = values.model.trim();
    if (model && model !== (view.model ?? "")) draft.model = model;
  }
  if (view.apiStyle !== undefined && extras.apiStyle && extras.apiStyle !== view.apiStyle) {
    draft.apiStyle = extras.apiStyle;
  }
  if (extras.headers !== undefined) draft.headers = extras.headers;
  return draft;
}

const numberError = (value: string, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? undefined
    : `Use a whole number from ${min} to ${max}.`;
};

export function validateLlmValues(values: LlmFieldValues, view: LlmSettingsView): LlmFieldErrors {
  const errors: LlmFieldErrors = {};
  const url = values.url.trim();
  if (!url) {
    errors.url = "Server URL is required.";
  } else if (url.length > 2048) {
    errors.url = "The URL must be at most 2048 characters.";
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.url = "Use an http or https URL.";
      } else if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        errors.url = "Remove credentials, query strings and fragments from the URL.";
      }
    } catch {
      errors.url = "Enter a valid http or https URL.";
    }
  }
  if (values.apiKey) {
    if (values.apiKey.length > 512 || !/^[\x21-\x7e]+$/.test(values.apiKey)) {
      errors.apiKey = "The API key must be 1–512 visible ASCII characters.";
    }
  } else if (needsNewKey(values, view)) {
    errors.apiKey = "A new API key is required because the server URL changed origin.";
  }
  const model = values.model.trim();
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    errors.model = "The model name must be at most 200 characters with no control characters.";
  }
  const maxTokens = numberError(values.maxTokens, LLM_LIMITS.maxTokens.min, LLM_LIMITS.maxTokens.max);
  if (maxTokens) errors.maxTokens = maxTokens;
  const timeoutSec = numberError(values.timeoutSec, LLM_LIMITS.timeoutSec.min, LLM_LIMITS.timeoutSec.max);
  if (timeoutSec) errors.timeoutSec = timeoutSec;
  const ratePerMin = numberError(values.ratePerMin, LLM_LIMITS.ratePerMin.min, LLM_LIMITS.ratePerMin.max);
  if (ratePerMin) errors.ratePerMin = ratePerMin;
  return errors;
}
