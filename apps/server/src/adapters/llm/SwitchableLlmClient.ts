import type { LlmClient, LlmEvent, LlmRequest } from "../../ports/assistant.js";
import type { LlmRuntime, LlmRuntimeConfig } from "../../ports/llm-settings.js";

export type LlmClientBuilder = (config: LlmRuntimeConfig | null) => LlmClient;

/**
 * Hot-swappable LLM client (ADR-16). `stream` captures the current client when the
 * iteration starts, so a configuration change never cuts a running answer; the next
 * message uses the new client. A failed build leaves the previous client untouched.
 */
export class SwitchableLlmClient implements LlmClient, LlmRuntime {
  private current: LlmClient;

  constructor(private readonly build: LlmClientBuilder, initial?: LlmClient) {
    this.current = initial ?? build(null);
  }

  get configured(): boolean {
    return this.current.configured;
  }

  get model(): string | null {
    return this.current.model;
  }

  get host(): string | null {
    return this.current.host;
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    const client = this.current;
    yield* client.stream(request, signal);
  }

  prepare(config: LlmRuntimeConfig | null): LlmClient {
    return this.build(config);
  }

  commit(client: LlmClient): void {
    this.current = client;
  }
}
