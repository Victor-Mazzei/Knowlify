import type { LlmClient } from "../../ports/assistant.js";
import type { LlmHeaderStored } from "../../domain/assistant/LlmHeaders.js";
import type { LlmApiStyle } from "../../domain/assistant/LlmApiStyle.js";
import { AnthropicLlmClient, type AnthropicLlmClientOptions } from "./AnthropicLlmClient.js";
import { NoLlmClient } from "./NoLlmClient.js";
import { OpenAiCompatibleLlmClient } from "./OpenAiCompatibleLlmClient.js";

export interface LlmClientConfig {
  url: string | null;
  apiKey: string | null;
  model: string | null;
  timeoutSec?: number;
  /** Absent means the original OpenAI-compatible style. */
  apiStyle?: LlmApiStyle;
  headers?: readonly LlmHeaderStored[];
}

export interface CreateLlmClientOptions {
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxResponseChars?: number;
  fetch?: typeof globalThis.fetch;
  /** Injected logger; provider failures are fixed categories, never provider text. */
  warn?: (message: string) => void;
}

type ClientBuilder = (options: AnthropicLlmClientOptions) => LlmClient;

/** Adding a style is a new entry here; existing builders do not change. */
const STYLE_BUILDERS: Readonly<Record<LlmApiStyle, ClientBuilder>> = {
  openai: (options) => new OpenAiCompatibleLlmClient(options),
  anthropic: (options) => new AnthropicLlmClient(options),
};

/**
 * Chat is optional: without a complete provider configuration the API keeps
 * answering and the UI hides every chat surface (silence, ADR-8 of the RAG plan).
 * Environment URLs keep the ADR-12 transport; UI-provided URLs pass the guarded
 * fetch from the composition root.
 */
export function createLlmClient(config: LlmClientConfig, options: CreateLlmClientOptions = {}): LlmClient {
  const { url, apiKey, model } = config;
  if (!url || !apiKey || !model) return new NoLlmClient();
  if (!isHttpUrl(url)) return new NoLlmClient();
  const build = STYLE_BUILDERS[config.apiStyle ?? "openai"];
  return build({
    url,
    apiKey,
    model,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.timeoutSec !== undefined ? { timeoutMs: config.timeoutSec * 1000 } : {}),
    ...(options.firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs: options.firstTokenTimeoutMs } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.maxResponseChars !== undefined ? { maxResponseChars: options.maxResponseChars } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}
