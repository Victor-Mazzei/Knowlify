import type { LlmProviderDiagnostic, LlmRequest } from "../../../ports/assistant.js";
import { LlmError } from "../../../ports/assistant.js";
import { LLM_API_STYLE_PROFILES } from "../../../domain/assistant/LlmApiStyle.js";
import type { LlmSseProtocol, SseChunkResult } from "../HttpSseLlmClient.js";

/**
 * Anthropic Messages API: `x-api-key` plus `anthropic-version`, named SSE events with the
 * type also inside `data:`, and no `[DONE]`. `temperature` is not sent: the 2026-10-21
 * version removed sampling parameters and current models reject them. Thinking blocks,
 * pings and unknown events are ignored but count as stream activity.
 */
export function anthropicProtocol(): LlmSseProtocol {
  return {
    name: "anthropic",
    endpoint(url) {
      let path = url.pathname.replace(/\/+$/, "");
      const lower = path.toLowerCase();
      if (!lower.endsWith("/v1/messages")) {
        path = lower.endsWith("/v1") ? `${path}/messages` : `${path}/v1/messages`;
      }
      url.pathname = path;
      url.hash = "";
      url.search = "";
      return url.toString();
    },
    headers(apiKey) {
      return {
        "content-type": "application/json",
        "x-api-key": apiKey,
        ...LLM_API_STYLE_PROFILES.anthropic.defaultHeaders,
      };
    },
    body(request: LlmRequest, model: string) {
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const messages = request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content }));
      return {
        model,
        max_tokens: request.maxTokens,
        ...(system ? { system } : {}),
        messages,
        stream: true,
      };
    },
    parseData: parseEvent,
    classifyError: classifyProviderError,
    // `max_tokens` is required and `temperature` is never sent, so there is nothing to drop.
    droppableParameter() {
      return undefined;
    },
  };
}

function parseEvent(payload: string): SseChunkResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new LlmError("protocol", "The language model provider sent malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LlmError("protocol", "The language model provider sent an unexpected event");
  }
  const event = parsed as {
    type?: unknown;
    delta?: unknown;
    error?: unknown;
  };
  if (event.type === "error") throw streamError(event.error);
  switch (event.type) {
    case "content_block_delta": {
      if (typeof event.delta !== "object" || event.delta === null) return { kind: "activity" };
      const delta = event.delta as { type?: unknown; text?: unknown };
      if (delta.type !== "text_delta") return { kind: "activity" };
      if (typeof delta.text !== "string") {
        throw new LlmError("protocol", "The language model provider sent an unexpected delta");
      }
      if (delta.text.length === 0) return { kind: "activity" };
      return { kind: "delta", text: delta.text };
    }
    case "message_delta": {
      if (typeof event.delta !== "object" || event.delta === null) return { kind: "activity" };
      const stopReason = (event.delta as { stop_reason?: unknown }).stop_reason;
      if (typeof stopReason !== "string") return { kind: "activity" };
      return {
        kind: "finish",
        reason: stopReason === "max_tokens" || stopReason === "model_context_window_exceeded" ? "length" : "stop",
      };
    }
    case "message_stop":
      return { kind: "done" };
    // message_start, content_block_start/stop, ping and future event types keep the stream alive.
    default:
      return { kind: "activity" };
  }
}

/** Maps a stream `error` event to a fixed diagnostic; the provider message is never used. */
function streamError(detail: unknown): LlmError {
  const type = typeof detail === "object" && detail !== null
    ? (detail as { type?: unknown }).type
    : undefined;
  switch (type) {
    case "overloaded_error":
    case "api_error":
    case "timeout_error":
      return new LlmError("unavailable", "The language model provider is unavailable", {
        providerDetail: "provider_unavailable",
      });
    case "rate_limit_error":
      return new LlmError("unavailable", "The language model provider is unavailable", {
        providerDetail: "rate_limited",
      });
    case "authentication_error":
      return new LlmError("rejected", "The language model provider rejected the request", {
        providerDetail: "authentication_failed",
      });
    case "permission_error":
    case "billing_error":
      return new LlmError("rejected", "The language model provider rejected the request", {
        providerDetail: "permission_denied",
      });
    case "invalid_request_error":
      return new LlmError("rejected", "The language model provider rejected the request", {
        providerDetail: "invalid_request",
      });
    default:
      return new LlmError("protocol", "The language model provider returned an error event");
  }
}

function classifyProviderError(status: number, raw: string): LlmProviderDiagnostic {
  if (status === 401) return "authentication_failed";
  if (status === 402 || status === 403) return "permission_denied";
  if (status === 413) return "context_length_exceeded";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  const text = anthropicErrorText(raw).toLowerCase();
  if (status === 404) {
    return /model/.test(text) ? "model_not_found" : "invalid_request";
  }
  if (status === 400) {
    if (/prompt is too long|context(?:[ _-]?(?:length|window))?|too many tokens/.test(text)) {
      return "context_length_exceeded";
    }
    if (/model/.test(text)) return "model_not_found";
    return "invalid_request";
  }
  return status >= 400 ? "invalid_request" : "unknown";
}

/**
 * Reads only `error.type` and `error.message`. Nothing from the body is forwarded; the
 * lowercased text is used only to choose a fixed diagnostic.
 */
function anthropicErrorText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "";
  const detail = error as { type?: unknown; message?: unknown };
  const fields: string[] = [];
  if (typeof detail.type === "string") fields.push(detail.type);
  if (typeof detail.message === "string") fields.push(detail.message);
  return fields.join(" ");
}
