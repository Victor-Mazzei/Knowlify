import {
  LlmError,
  type LlmClient,
  type LlmEvent,
  type LlmProviderDiagnostic,
  type LlmRequest,
} from "../../ports/assistant.js";
import { renderLlmHeaders, type LlmHeaderStored } from "../../domain/assistant/LlmHeaders.js";

export const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_CHARS = 20_000;
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
/** Bounds reading the provider's error body; enough for a JSON error, never the prompt. */
export const MAX_ERROR_BODY_BYTES = 8 * 1024;

export type SseChunkResult =
  | { kind: "ignore" }
  /** A valid protocol event with no user-visible text; it still proves the stream is alive. */
  | { kind: "activity" }
  | { kind: "delta"; text: string; finish?: "stop" | "length" }
  | { kind: "finish"; reason: "stop" | "length" }
  | { kind: "done" };

/**
 * Wire format of one provider style. Composition, not inheritance: the transport below is
 * shared and each protocol only describes endpoint, headers, body, events and errors.
 */
export interface LlmSseProtocol {
  readonly name: string;
  /** Final request URL, built from the configured base URL. */
  endpoint(url: URL): string;
  /** Protocol-owned headers: content type, credentials and version. Custom headers are merged later. */
  headers(apiKey: string): Record<string, string>;
  body(request: LlmRequest, model: string): Record<string, unknown>;
  /** Parses the JSON of one `data:` line. `[DONE]` is handled by the transport. */
  parseData(payload: string): SseChunkResult;
  /** Fixed diagnostic for a non-2xx body; provider text never leaves the protocol. */
  classifyError(status: number, raw: string): LlmProviderDiagnostic;
  /** Optional parameter the provider may reject with 400 and that a single retry may drop. */
  droppableParameter(diagnostic: LlmProviderDiagnostic): "max_tokens" | "temperature" | undefined;
}

export interface HttpSseLlmClientOptions {
  url: string;
  apiKey: string;
  model: string;
  protocol: LlmSseProtocol;
  /** Resolved custom headers; rendered per request with the conversation id. */
  headers?: readonly LlmHeaderStored[];
  timeoutMs?: number;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxResponseChars?: number;
  maxLineBytes?: number;
  /** Test seam; production uses console.warn so provider failures are visible in the log. */
  warn?: (message: string) => void;
  /** Test seam; production uses the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Shared SSE transport. Environment URLs keep the ADR-12 exception (private addresses
 * allowed); UI-provided URLs arrive through the guarded fetch, which pins the validated
 * address and refuses redirects. Oversized lines, bodies and slow servers are refused.
 * Provider error bodies are read only in a bounded window and reduced to a fixed
 * diagnostic before they reach the log or the client; provider text never leaves this
 * adapter, so the prompt, passages, key and custom header values cannot leak.
 */
export class HttpSseLlmClient implements LlmClient {
  readonly configured = true;
  readonly model: string;
  readonly host: string | null;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxResponseChars: number;
  private readonly maxLineBytes: number;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly warn: (message: string) => void;

  constructor(private readonly options: HttpSseLlmClientOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxResponseChars = options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.warn = options.warn ?? ((message) => console.warn(message));
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid LLM URL");
    if (url.username || url.password) throw new Error("Invalid LLM URL");
    this.host = url.hostname;
    this.endpoint = options.protocol.endpoint(url);
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    const controller = new AbortController();
    let timedOut = false;
    let completed = false;
    let phaseTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const abortFromCaller = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromCaller, { once: true });

    const armPhase = (ms: number) => {
      if (phaseTimer) clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms);
    };
    totalTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    armPhase(this.firstTokenTimeoutMs);

    try {
      const payload = this.options.protocol.body(request, this.options.model);
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2 && response === undefined; attempt += 1) {
        const current = await this.doFetch(this.endpoint, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: this.requestHeaders(request.sessionId),
          body: JSON.stringify(payload),
        });
        if (current.ok) {
          response = current;
          break;
        }
        const diagnostic = await readProviderError(current, this.options.protocol);
        this.warn(providerLogMessage(current.status, diagnostic));
        // Compatibility fallback: one retry only, and only when the 400 names one of the
        // optional fields this protocol sends. Never guessed from an unrelated rejection.
        const rejected = attempt === 0 ? this.options.protocol.droppableParameter(diagnostic) : undefined;
        if (current.status === 400 && rejected) {
          this.warn(`[llm] provider rejected optional parameter "${rejected}"; retrying once without it`);
          delete payload[rejected];
          continue;
        }
        throw this.providerError(current.status, diagnostic);
      }
      if (!response) throw new LlmError("unavailable", "The language model provider could not be reached");
      if (!response.body) throw new LlmError("protocol", "The language model provider returned an empty response");

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let textChars = 0;
      let finishReason: "stop" | "length" = "stop";
      let sawFinish = false;

      const consume = (line: string): SseChunkResult => {
        const trimmed = line.replace(/\r$/, "");
        if (!trimmed.startsWith("data:")) return { kind: "ignore" };
        const payloadText = trimmed.slice(5).trim();
        if (!payloadText) return { kind: "ignore" };
        if (payloadText === "[DONE]") return { kind: "done" };
        return this.options.protocol.parseData(payloadText);
      };

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value) continue;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length > this.maxLineBytes) {
            throw new LlmError("protocol", "The language model provider sent an oversized event");
          }
          const result = consume(line);
          if (result.kind === "delta") {
            textChars += result.text.length;
            if (textChars > this.maxResponseChars) {
              throw new LlmError("protocol", "The language model response is too long");
            }
            if (result.finish) {
              finishReason = result.finish;
              sawFinish = true;
            }
            armPhase(this.idleTimeoutMs);
            yield { type: "delta", text: result.text };
          } else if (result.kind === "activity") {
            armPhase(this.idleTimeoutMs);
          } else if (result.kind === "finish") {
            finishReason = result.reason;
            sawFinish = true;
          } else if (result.kind === "done") {
            completed = true;
            yield { type: "done", finishReason };
            return;
          }
          newline = buffer.indexOf("\n");
        }
        // A single unterminated event may not grow without bound waiting for its newline.
        if (buffer.length > this.maxLineBytes) {
          throw new LlmError("protocol", "The language model provider sent an oversized event");
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const result = consume(buffer);
        if (result.kind === "delta") {
          textChars += result.text.length;
          if (textChars > this.maxResponseChars) {
            throw new LlmError("protocol", "The language model response is too long");
          }
          if (result.finish) {
            finishReason = result.finish;
            sawFinish = true;
          }
          yield { type: "delta", text: result.text };
        } else if (result.kind === "finish") {
          finishReason = result.reason;
          sawFinish = true;
        } else if (result.kind === "done") {
          completed = true;
          yield { type: "done", finishReason };
          return;
        }
      }
      // Some compatible providers close the stream after a finish marker without an end event.
      if (sawFinish) {
        completed = true;
        yield { type: "done", finishReason };
        return;
      }
      throw new LlmError("protocol", "The language model stream ended unexpectedly");
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (signal.aborted) throw new LlmError("aborted", "The chat request was cancelled");
      if (timedOut) throw new LlmError("timeout", "The language model took too long to answer");
      throw new LlmError("unavailable", "The language model provider could not be reached");
    } finally {
      if (phaseTimer) clearTimeout(phaseTimer);
      if (totalTimer) clearTimeout(totalTimer);
      signal.removeEventListener("abort", abortFromCaller);
      if (reader && !completed) await reader.cancel().catch(() => undefined);
    }
  }

  private requestHeaders(sessionId: string | undefined): Record<string, string> {
    return {
      ...this.options.protocol.headers(this.options.apiKey),
      ...renderLlmHeaders(this.options.headers ?? [], { conversationId: sessionId }),
    };
  }

  private providerError(status: number, diagnostic: LlmProviderDiagnostic): LlmError {
    const details = { providerStatus: status, providerDetail: diagnostic };
    if (status === 429 || status >= 500) {
      return new LlmError("unavailable", `The language model provider is unavailable (status ${status})`, details);
    }
    return new LlmError("rejected", `The language model provider rejected the request (status ${status})`, details);
  }
}

/**
 * Reads only the first bytes of a failed response and lets the protocol classify them. The
 * raw body is untrusted and may echo the prompt, passages, URLs or credentials, so it is
 * used only to pick a fixed diagnostic; it is never returned or logged.
 */
export async function readProviderError(
  response: Response,
  protocol: LlmSseProtocol,
): Promise<LlmProviderDiagnostic> {
  const body = response.body;
  if (!body) return protocol.classifyError(response.status, "");
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const remaining = MAX_ERROR_BODY_BYTES - total;
      const chunk = value.length <= remaining ? value : value.subarray(0, remaining);
      chunks.push(Buffer.from(chunk));
      total += chunk.length;
      if (chunk.length < value.length) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return protocol.classifyError(response.status, Buffer.concat(chunks).toString("utf8"));
}

export function providerLogMessage(status: number, diagnostic: LlmProviderDiagnostic): string {
  return `[llm] provider returned status ${status} (${diagnostic})`;
}
