import { LlmError, type LlmClient, type LlmEvent, type LlmRequest } from "../../ports/assistant.js";

/** Placeholder used until a provider is configured; it keeps the chat surface disabled. */
export class NoLlmClient implements LlmClient {
  readonly configured = false;
  readonly model: string | null = null;
  readonly host: string | null = null;

  async *stream(_request: LlmRequest, _signal: AbortSignal): AsyncIterable<LlmEvent> {
    throw new LlmError("unavailable", "No LLM provider is configured");
  }
}
