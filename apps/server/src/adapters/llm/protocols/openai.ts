import type { LlmProviderDiagnostic, LlmRequest } from "../../../ports/assistant.js";
import { LlmError } from "../../../ports/assistant.js";
import { LLM_API_STYLE_PROFILES } from "../../../domain/assistant/LlmApiStyle.js";
import type { LlmSseProtocol, SseChunkResult } from "../HttpSseLlmClient.js";

/** OpenAI-compatible chat completions: Bearer key, `choices[].delta.content`, `[DONE]`. */
export function openAiProtocol(): LlmSseProtocol {
  return {
    name: "openai",
    endpoint(url) {
      const path = url.pathname.replace(/\/+$/, "");
      // Operators may set either the base (…/v1) or the full endpoint. Appending blindly
      // would turn a full endpoint into …/chat/completions/chat/completions.
      url.pathname = path.toLowerCase().endsWith("/chat/completions") ? path : `${path}/chat/completions`;
      url.hash = "";
      return url.toString();
    },
    headers(apiKey) {
      return {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...LLM_API_STYLE_PROFILES.openai.defaultHeaders,
      };
    },
    body(request: LlmRequest, model: string) {
      return {
        model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        stream: true,
      };
    },
    parseData: parseChunk,
    classifyError: classifyProviderError,
    droppableParameter(diagnostic) {
      // Only optional fields this client sends may be retried; real failures never are.
      if (diagnostic === "unsupported_max_tokens") return "max_tokens";
      if (diagnostic === "unsupported_temperature") return "temperature";
      return undefined;
    },
  };
}

function parseChunk(payload: string): SseChunkResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new LlmError("protocol", "The language model provider sent malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LlmError("protocol", "The language model provider sent an unexpected event");
  }
  const record = parsed as { choices?: unknown; error?: unknown };
  if (record.error !== undefined) {
    throw new LlmError("protocol", "The language model provider returned an error event");
  }
  if (!Array.isArray(record.choices) || record.choices.length === 0) return { kind: "ignore" };
  const choice = record.choices[0];
  if (typeof choice !== "object" || choice === null) {
    throw new LlmError("protocol", "The language model provider sent an unexpected choice");
  }
  const { delta, finish_reason: finishReason } = choice as { delta?: unknown; finish_reason?: unknown };
  if (delta !== undefined && delta !== null) {
    if (typeof delta !== "object") throw new LlmError("protocol", "The language model provider sent an unexpected delta");
    const content = (delta as { content?: unknown }).content;
    const reasoning = (delta as { reasoning_content?: unknown }).reasoning_content;
    if (content !== undefined && content !== null && typeof content !== "string") {
      throw new LlmError("protocol", "The language model provider sent an unexpected delta");
    }
    if (typeof content === "string" && content.length > 0) {
      const finish = typeof finishReason === "string"
        ? (finishReason === "length" ? "length" : "stop")
        : undefined;
      return { kind: "delta", text: content, ...(finish ? { finish } : {}) };
    }
    if (typeof finishReason === "string") {
      return { kind: "finish", reason: finishReason === "length" ? "length" : "stop" };
    }
    // Reasoning models stream `reasoning_content` long before `content`. It is internal
    // and never forwarded, but it proves the provider is alive: without this the
    // first-token timer would abort a model that is still thinking.
    if (typeof reasoning === "string" && reasoning.length > 0) return { kind: "activity" };
    return { kind: "ignore" };
  }
  if (typeof finishReason === "string") {
    return { kind: "finish", reason: finishReason === "length" ? "length" : "stop" };
  }
  return { kind: "ignore" };
}

function classifyProviderError(status: number, raw: string): LlmProviderDiagnostic {
  if (status === 401) return "authentication_failed";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";

  const text = providerErrorText(raw).toLowerCase();
  // A real auth/model/context failure wins over any echoed optional-parameter words.
  // Retry is only allowed when the rejection is unambiguously about the parameter itself.
  if (mentionsMissingSession(text)) return "missing_session";
  if (mentionsAuthenticationFailure(text)) return "authentication_failed";
  if (mentionsPermissionDenied(text)) return "permission_denied";
  if (mentionsContextLength(text)) return "context_length_exceeded";
  if (mentionsModelNotFound(text)) return "model_not_found";
  if (mentionsRateLimit(text)) return "rate_limited";
  if (mentionsUnsupportedParameter(text, "max_tokens")) return "unsupported_max_tokens";
  if (mentionsUnsupportedParameter(text, "temperature")) return "unsupported_temperature";
  return status >= 400 ? "invalid_request" : "unknown";
}

/**
 * Extracts only the known diagnostic fields from a JSON error. Unknown properties are
 * ignored so a body that echoes the prompt cannot smuggle it into the classifier output.
 */
export function providerErrorText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some gateways answer 400 with a plain-text or truncated body.
    return text;
  }
  if (typeof parsed === "string") return parsed;
  return collectProviderStrings(parsed).join(" ");
}

function collectProviderStrings(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of ["type", "code", "message", "detail"]) {
    const field = record[key];
    if (typeof field === "string") fields.push(field);
  }
  const error = record.error;
  if (typeof error === "string") {
    fields.push(error);
  } else if (typeof error === "object" && error !== null) {
    const detail = error as Record<string, unknown>;
    for (const key of ["type", "code", "message"]) {
      const field = detail[key];
      if (typeof field === "string") fields.push(field);
    }
  }
  return fields;
}

/** Generic wording: the client no longer knows any provider-specific session header name. */
const MISSING_SESSION = /missing\s*(?:session|sessionid)|missing\s+session\s+header/;

function mentionsMissingSession(text: string): boolean {
  return MISSING_SESSION.test(text);
}

/**
 * A provider body may mix a real failure with words echoed from the request. To retry,
 * the rejection and the parameter must be adjacent in the same clause; separate evidence
 * (e.g. "invalid api key; temperature is 0.3") is not enough.
 */
function mentionsUnsupportedParameter(text: string, parameter: "max_tokens" | "temperature"): boolean {
  const rejection = "(?:unsupported|not[ _-]+supported|unknown|unrecognized|unexpected|not[ _-]+allowed|invalid)";
  const descriptor = "(?:\\s+(?:parameter|field|argument|option|value(?:\\s+for)?|request\\s+argument(?:\\s+supplied)?))?";
  const quote = "[\"'`]?";
  const before = new RegExp(`${rejection}${descriptor}\\s*[:=]?\\s*${quote}\\b${parameter}\\b${quote}`);
  const after = new RegExp(`\\b${parameter}\\b\\s*${quote}[\\s:=]*(?:is|are|was|were)?[\\s:=]*${rejection}\\b`);
  const doesNotSupport = new RegExp(`(?:does\\s+not|doesn't)\\s+support\\s+(?:the\\s+)?${quote}\\b${parameter}\\b`);
  return before.test(text) || after.test(text) || doesNotSupport.test(text);
}

function mentionsContextLength(text: string): boolean {
  return /(context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|token limit|reduce the length|context_length_exceeded)/.test(text);
}

function mentionsModelNotFound(text: string): boolean {
  return /((?:unknown|invalid|unsupported|missing|no such)\s+model|model[^.]{0,40}(?:not found|not exist|unknown|invalid|unsupported|does not exist)|model_not_found)/.test(text);
}

function mentionsAuthenticationFailure(text: string): boolean {
  return /(unauthorized|authentication failed|invalid authentication|invalid credentials|(?:invalid|incorrect|bad|missing|revoked|expired)[ _-]+api[ _-]?key|api[ _-]?key[^.]{0,20}(?:invalid|incorrect|missing|revoked|expired|not valid|not provided)|(?:invalid|expired|revoked)[ _-]+(?:bearer[ _-]+|access[ _-]+)?token|(?:bearer[ _-]+|access[ _-]+)?token[^.]{0,20}(?:invalid|expired|revoked|missing)|no api key provided)/.test(text);
}

function mentionsPermissionDenied(text: string): boolean {
  return /(permission denied|forbidden|access denied|not authorized)/.test(text);
}

function mentionsRateLimit(text: string): boolean {
  return /(rate limit|too many requests|quota exceeded)/.test(text);
}
