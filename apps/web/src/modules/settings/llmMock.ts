import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { styleOf } from "./llmHeaders";
import {
  applyHeaderRequest,
  assertHeadersAllowed,
  originOf,
  readApiStyle,
  sameOrigin,
} from "./llmMockHeaders";
import {
  MOCK_LLM_SCENARIOS,
  envHeaders,
  initialHeaders,
  initialLlmView,
  modelsFor,
  viewHeaders,
  type MockLlmScenario,
  type MockView,
} from "./llmMockViews";
import type { LlmProbeCode, LlmSettingsSaveResult, LlmTestResponse } from "./llmTypes";
import { applyPromptSave } from "./llmPromptMock";

export { MOCK_LLM_SCENARIOS, initialLlmView, type MockLlmScenario, type MockView };

type MockLlmOptions = { scenario?: MockLlmScenario };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fail = (status: number, message: string, code?: string): never => {
  throw new ApiError(status, message, code);
};

/** The real PUT response mirrors the connection view, not the GET-only persona. */
const connectionResponse = (view: MockView): LlmSettingsSaveResult => {
  const { prompt: _persona, ...connection } = view;
  return connection;
};

const readBody = (init: RequestInit | undefined): Record<string, unknown> | null => {
  if (typeof init?.body !== "string") return null;
  try {
    const value: unknown = JSON.parse(init.body);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const readNumber = (body: Record<string, unknown>, key: string) =>
  typeof body[key] === "number" && Number.isFinite(body[key]) ? body[key] : undefined;

const readString = (body: Record<string, unknown>, key: string) =>
  typeof body[key] === "string" && body[key].trim() ? body[key].trim() : undefined;

const hasProbeDraft = (body: Record<string, unknown> | null) =>
  body !== null &&
  ("url" in body || "apiKey" in body || "model" in body || "apiStyle" in body || "headers" in body);

const probeCode = (scenario: MockLlmScenario): LlmProbeCode | undefined => {
  if (scenario === "blocked") return "blocked";
  if (scenario === "unauthorized") return "unauthorized";
  return undefined;
};

/** Private destinations are blocked unless the operator allows them. */
const checkUrl = (url: string) => {
  if (!url) return fail(400, "Server URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail(400, "Enter a valid http or https URL.");
  }
  const host = parsed.hostname;
  const privateHost = host === "localhost" || host === "127.0.0.1" || host === "::1" || /^(10|192\.168)\./.test(host);
  if (privateHost) {
    fail(400, "Private addresses are blocked. The server owner can allow them with KNOWLIFY_LLM_ALLOW_PRIVATE.");
  }
};

/** A stored key is never reused for a draft URL on another origin (ADR-14). */
const draftNeedsKey = (body: Record<string, unknown> | null, view: MockView) => {
  if (!view.hasKey || !view.url || readString(body ?? {}, "apiKey")) return false;
  const draftUrl = readString(body ?? {}, "url");
  if (!draftUrl) return false;
  const before = originOf(view.url);
  const after = originOf(draftUrl);
  return Boolean(before && after && before !== after);
};

/** In-memory stand-in for `/api/settings/llm/*`, used by tests and `?mock=llm` in dev. */
export function createMockLlmApi(options: MockLlmOptions = {}): ApiFn {
  const scenario = options.scenario ?? "configured";
  let view = { ...initialLlmView(scenario) };
  let headerValues = initialHeaders(scenario);

  return async (path, init = {}) => {
    const url = new URL(path, "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    const body = readBody(init);

    // The network guard blocks every non-GET `/api/settings/*` request from a phone.
    if (scenario === "local_only" && method !== "GET") fail(403, "Forbidden", "local_only");

    if (url.pathname === "/api/settings/llm" && method === "GET") return json(200, view);

    if (url.pathname === "/api/settings/llm" && method === "PUT") {
      if (view.locked) fail(403, "AI settings are managed by the server environment.");
      if (scenario === "blocked") {
        fail(400, "Private addresses are blocked. The server owner can allow them with KNOWLIFY_LLM_ALLOW_PRIVATE.");
      }
      const serverUrl = readString(body ?? {}, "url") ?? "";
      checkUrl(serverUrl);
      const apiKey = readString(body ?? {}, "apiKey");
      const nextModel =
        body?.model === null ? null : typeof body?.model === "string" ? body.model.trim() || null : view.model;
      const apiStyle = readApiStyle(body, view.apiStyle);
      let headers = view.headers ?? [];
      let headersState = view.headersState ?? "none";
      if (body && "headers" in body) {
        headerValues = applyHeaderRequest(view, headerValues, body.headers, serverUrl, apiStyle);
        headers = viewHeaders(headerValues);
        headersState = headers.length ? "set" : "none";
      } else if (!sameOrigin(serverUrl, view.url)) {
        headerValues = new Map();
        headers = [];
        headersState = "none";
      }
      assertHeadersAllowed(headers, view, serverUrl, apiStyle);
      const hasKey = apiKey ? true : view.hasKey;
      const keyState = apiKey ? "set" : view.keyState;
      view = {
        ...view,
        source: "db",
        enabled: keyState !== "unreadable" && headersState !== "unreadable",
        url: serverUrl,
        model: nextModel,
        hasKey,
        keyState,
        maxTokens: readNumber(body ?? {}, "maxTokens") ?? view.maxTokens,
        timeoutSec: readNumber(body ?? {}, "timeoutSec") ?? view.timeoutSec,
        ratePerMin: readNumber(body ?? {}, "ratePerMin") ?? view.ratePerMin,
        apiStyle,
        headers,
        headersState,
      };
      return json(200, connectionResponse(view));
    }

    if (url.pathname === "/api/settings/llm/prompt" && method === "PUT") {
      if (view.locked) fail(403, "AI settings are managed by the server environment.");
      const prompt = applyPromptSave(view.prompt, body);
      view = { ...view, prompt };
      return json(200, prompt);
    }

    if (url.pathname === "/api/settings/llm/key" && method === "DELETE") {
      if (view.locked) fail(403, "AI settings are managed by the server environment.");
      view = { ...view, hasKey: false, keyState: "none", enabled: false };
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/settings/llm" && method === "DELETE") {
      if (view.locked) fail(403, "AI settings are managed by the server environment.");
      const prompt = view.prompt;
      view = scenario === "empty" ? initialLlmView("empty") : { ...initialLlmView("env"), locked: false };
      // The persona has its own lifecycle: resetting the connection keeps it (D3).
      view = { ...view, prompt: { ...prompt, locked: view.locked } };
      headerValues = scenario === "empty" ? new Map() : envHeaders();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/settings/llm/models" && method === "POST") {
      if (view.locked && hasProbeDraft(body)) {
        fail(403, "The LLM configuration is managed by the server environment");
      }
      if (scenario === "rate-limited") fail(429, "Too many requests. Try again in 12 seconds.");
      const style = readApiStyle(body, styleOf(view));
      if (body && "headers" in body) {
        const draftUrl = readString(body, "url") ?? view.url ?? "";
        applyHeaderRequest(view, headerValues, body.headers, draftUrl, style);
      }
      if (draftNeedsKey(body, view)) {
        return json(200, { supported: false, models: [], code: "key_required" });
      }
      if (scenario === "models-unsupported") return json(200, { supported: false, models: [] });
      const code = probeCode(scenario);
      if (code) return json(200, { supported: false, models: [], code });
      return json(200, { supported: true, models: modelsFor(style) });
    }

    if (url.pathname === "/api/settings/llm/test" && method === "POST") {
      if (view.locked && hasProbeDraft(body)) {
        fail(403, "The LLM configuration is managed by the server environment");
      }
      if (scenario === "rate-limited") fail(429, "Too many requests. Try again in 12 seconds.");
      const style = readApiStyle(body, styleOf(view));
      if (body && "headers" in body) {
        const draftUrl = readString(body, "url") ?? view.url ?? "";
        applyHeaderRequest(view, headerValues, body.headers, draftUrl, style);
      }
      if (scenario === "key-unreadable" && !readString(body ?? {}, "apiKey")) {
        return json(200, { ok: false, latencyMs: 0, code: "key_required" });
      }
      if (draftNeedsKey(body, view)) {
        return json(200, { ok: false, latencyMs: 0, code: "key_required" });
      }
      const code = probeCode(scenario);
      if (code) return json(200, { ok: false, latencyMs: 24, code });
      const model = readString(body ?? {}, "model") ?? view.model ?? "";
      const response: LlmTestResponse = {
        ok: true,
        latencyMs: 42,
        modelFound: Boolean(model) && modelsFor(style).includes(model),
      };
      return json(200, response);
    }

    return fail(404, "Mock LLM route not found.");
  };
}

export function mockLlmScenario(value: string | null): MockLlmScenario {
  return (MOCK_LLM_SCENARIOS as readonly string[]).includes(value ?? "")
    ? (value as MockLlmScenario)
    : "configured";
}
