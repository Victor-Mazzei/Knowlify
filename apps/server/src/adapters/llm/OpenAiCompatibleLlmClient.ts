import type { LlmClient, LlmEvent, LlmRequest } from "../../ports/assistant.js";
import type { LlmHeaderStored } from "../../domain/assistant/LlmHeaders.js";
import { HttpSseLlmClient } from "./HttpSseLlmClient.js";
import { openAiProtocol } from "./protocols/openai.js";

export interface OpenAiCompatibleLlmClientOptions {
  /** Base URL (…/v1) or the full chat-completions endpoint (…/chat/completions). */
  url: string;
  apiKey: string;
  model: string;
  /** Resolved custom headers (values are secrets). */
  headers?: readonly LlmHeaderStored[];
  /** Total request budget. */
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

/** OpenAI-compatible chat completions; the transport and parsing live in `HttpSseLlmClient`. */
export class OpenAiCompatibleLlmClient implements LlmClient {
  private readonly client: HttpSseLlmClient;

  constructor(options: OpenAiCompatibleLlmClientOptions) {
    this.client = new HttpSseLlmClient({ ...options, protocol: openAiProtocol() });
  }

  get configured(): boolean {
    return this.client.configured;
  }

  get model(): string | null {
    return this.client.model;
  }

  get host(): string | null {
    return this.client.host;
  }

  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    return this.client.stream(request, signal);
  }
}
