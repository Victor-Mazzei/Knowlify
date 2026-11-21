import type { ApiFn } from "../../components/dialogs";
import { ApiError, formatError } from "../../services/api";
import { createMockLlmApi, mockLlmScenario } from "./llmMock";
import { LLM_STYLE_PROFILES } from "./llmStyles";
import type {
  LlmApiStyle,
  LlmHeaderView,
  LlmModelsResponse,
  LlmProbeCode,
  LlmProbeRequest,
  LlmPromptSaveRequest,
  LlmPromptView,
  LlmSaveRequest,
  LlmSettingsSaveResult,
  LlmSettingsView,
  LlmTestResponse,
} from "./llmTypes";

export type LlmApi = {
  get: () => Promise<LlmSettingsView>;
  save: (body: LlmSaveRequest) => Promise<LlmSettingsSaveResult>;
  savePrompt: (systemPrompt: string | null) => Promise<LlmPromptView>;
  clearKey: () => Promise<void>;
  reset: () => Promise<void>;
  models: (body: LlmProbeRequest) => Promise<LlmModelsResponse>;
  test: (body: LlmProbeRequest) => Promise<LlmTestResponse>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isOneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);

const isSource = isOneOf(["env", "db", "none"] as const);
const isKeyState = isOneOf(["none", "set", "unreadable"] as const);
const isApiStyle = isOneOf(["openai", "anthropic"] as const);
const isHeadersState = isOneOf(["none", "set", "unreadable"] as const);
const isProbeCode = isOneOf([
  "blocked",
  "https_required",
  "unreachable",
  "timeout",
  "tls",
  "unauthorized",
  "not_found",
  "rejected",
  "key_required",
] as const);

const isHeaderView = (value: unknown): value is LlmHeaderView =>
  isRecord(value) && typeof value.name === "string" && value.name.length > 0 && typeof value.hasValue === "boolean";

const isPromptView = (value: unknown): value is LlmPromptView =>
  isRecord(value) &&
  (value.custom === null || typeof value.custom === "string") &&
  typeof value.default === "string" &&
  typeof value.version === "string" &&
  isNumber(value.maxChars) &&
  typeof value.locked === "boolean";

type SettingsSavePayload = LlmSettingsSaveResult & { prompt?: unknown };

/**
 * PUT returns the connection view without `prompt`; GET adds the persona separately.
 * `apiStyle`, `headers` and `headersState` are optional so an older server still works.
 */
const isSettingsSaveResult = (value: unknown): value is SettingsSavePayload => {
  if (!isRecord(value)) return false;
  const defaults = value.defaults;
  const policy = value.policy;
  return (
    isSource(value.source) &&
    typeof value.locked === "boolean" &&
    typeof value.enabled === "boolean" &&
    (value.url === null || typeof value.url === "string") &&
    (value.model === null || typeof value.model === "string") &&
    typeof value.hasKey === "boolean" &&
    isKeyState(value.keyState) &&
    isNumber(value.maxTokens) &&
    isNumber(value.timeoutSec) &&
    isNumber(value.ratePerMin) &&
    isRecord(defaults) &&
    isNumber(defaults.maxTokens) &&
    isNumber(defaults.timeoutSec) &&
    isNumber(defaults.ratePerMin) &&
    isRecord(policy) &&
    isOneOf(["off", "on", "list"] as const)(policy.allowPrivate) &&
    policy.publicRequiresHttps === true &&
    (value.apiStyle === undefined || isApiStyle(value.apiStyle)) &&
    (value.headers === undefined ||
      (Array.isArray(value.headers) && value.headers.every(isHeaderView))) &&
    (value.headersState === undefined || isHeadersState(value.headersState))
  );
};

const isSettingsView = (value: unknown): value is LlmSettingsView =>
  isSettingsSaveResult(value) && isPromptView(value.prompt);

const isModelsResponse = (value: unknown): value is LlmModelsResponse =>
  isRecord(value) &&
  typeof value.supported === "boolean" &&
  Array.isArray(value.models) &&
  value.models.every((model) => typeof model === "string") &&
  (value.code === undefined || isProbeCode(value.code));

const isTestResponse = (value: unknown): value is LlmTestResponse =>
  isRecord(value) &&
  typeof value.ok === "boolean" &&
  isNumber(value.latencyMs) &&
  (value.code === undefined || isProbeCode(value.code)) &&
  (value.modelFound === undefined || typeof value.modelFound === "boolean");

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function request<T>(
  api: ApiFn,
  path: string,
  init: RequestInit,
  guard: (value: unknown) => value is T,
): Promise<T> {
  const response = await api(path, init);
  const body: unknown = await response.json();
  if (!guard(body)) throw new Error("The server sent an unexpected response.");
  return body;
}

/** Error text shared by the card and its probes; 429 keeps the server's wait hint. */
export const describeError = (reason: unknown) => {
  if (reason instanceof ApiError && reason.status === 429) {
    return reason.message || "Too many requests. Try again in a minute.";
  }
  return formatError(reason);
};

/** Message shown for a failed probe; the server never forwards provider text. */
export function probeMessage(code: LlmProbeCode | undefined, style: LlmApiStyle = "openai"): string {
  switch (code) {
    case "blocked":
      return "Private addresses are blocked. The server owner can allow them with KNOWLIFY_LLM_ALLOW_PRIVATE.";
    case "https_required":
      return "Public servers need HTTPS on port 443.";
    case "unreachable":
      return "The server could not be reached.";
    case "timeout":
      return "The server took too long to answer.";
    case "tls":
      return "The TLS certificate could not be verified.";
    case "unauthorized":
      return "The server rejected the API key.";
    case "not_found":
      return LLM_STYLE_PROFILES[style].notFound;
    case "rejected":
      return "The server rejected the test request.";
    case "key_required":
      return "An API key is required for this server.";
    default:
      return "The connection test failed.";
  }
}

export function createLlmApi(api: ApiFn): LlmApi {
  return {
    get: () => request(api, "/api/settings/llm", {}, isSettingsView),
    save: (body) => request(api, "/api/settings/llm", jsonInit("PUT", body), isSettingsSaveResult),
    savePrompt: (systemPrompt) =>
      request(
        api,
        "/api/settings/llm/prompt",
        jsonInit("PUT", { systemPrompt } satisfies LlmPromptSaveRequest),
        isPromptView,
      ),
    clearKey: async () => {
      await api("/api/settings/llm/key", { method: "DELETE" });
    },
    reset: async () => {
      await api("/api/settings/llm", { method: "DELETE" });
    },
    models: (body) => request(api, "/api/settings/llm/models", jsonInit("POST", body), isModelsResponse),
    test: (body) => request(api, "/api/settings/llm/test", jsonInit("POST", body), isTestResponse),
  };
}

/**
 * Application wiring: `?mock=llm` (plus optional `&scenario=...`) swaps in the
 * in-memory provider tree without touching `services/api`.
 */
export function llmApi(api: ApiFn): LlmApi {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mock") === "llm") {
      return createLlmApi(createMockLlmApi({ scenario: mockLlmScenario(query.get("scenario")) }));
    }
  }
  return createLlmApi(api);
}
