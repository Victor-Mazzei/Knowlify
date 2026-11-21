import type { LlmClient, LlmEvent, LlmRequest } from "../../ports/assistant.js";
import type { LlmHeaderStored } from "../../domain/assistant/LlmHeaders.js";
import { HttpSseLlmClient } from "./HttpSseLlmClient.js";
import { anthropicProtocol } from "./protocols/anthropic.js";

export interface AnthropicLlmClientOptions {
  /** Base URL without /v1 (…/anthropic) or the full /v1/messages endpoint. */
  url: string;
  apiKey: string;
  model: string;
  /** Resolved custom headers (values are secrets). */
  headers?: readonly LlmHeaderStored[];
  timeoutMs?: number;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxResponseChars?: number;
  maxLineBytes?: number;
  warn?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
}

/** Anthropic Messages API over SSE; shares the transport with the OpenAI-compatible client. */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: HttpSseLlmClient;

  constructor(options: AnthropicLlmClientOptions) {
    this.client = new HttpSseLlmClient({ ...options, protocol: anthropicProtocol() });
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
