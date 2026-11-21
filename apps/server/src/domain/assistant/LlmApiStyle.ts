/**
 * Wire protocol spoken by the provider. `openai` is the chat-completions style
 * (Bearer key); `anthropic` is the Messages API (`x-api-key` plus a version header).
 * The style is pure configuration: it selects the profile below and never changes the
 * prompt, citations or safety envelope built by the chat use case.
 */
export type LlmApiStyle = "openai" | "anthropic";

export const LLM_API_STYLES: readonly LlmApiStyle[] = ["openai", "anthropic"];

/** Long-lived version accepted by the current Messages API and by Anthropic-compatible gateways. */
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export interface LlmApiStyleProfile {
  /** Headers the style owns; the user cannot set or override them. */
  readonly managedHeaders: readonly string[];
  /** Defaults the user may override with a custom header of the same name (for example `anthropic-version`). */
  readonly defaultHeaders: Readonly<Record<string, string>>;
}

export const LLM_API_STYLE_PROFILES: Readonly<Record<LlmApiStyle, LlmApiStyleProfile>> = {
  openai: {
    managedHeaders: ["authorization"],
    defaultHeaders: { "user-agent": "knowlify" },
  },
  anthropic: {
    managedHeaders: ["x-api-key", "authorization"],
    defaultHeaders: {
      "anthropic-version": DEFAULT_ANTHROPIC_VERSION,
      "user-agent": "knowlify",
    },
  },
};

/** Parses a persisted or environment value; absent means the original OpenAI-compatible style. */
export function parseLlmApiStyle(value: unknown): LlmApiStyle {
  if (value === undefined || value === null) return "openai";
  if (value === "openai" || value === "anthropic") return value;
  throw new Error("The LLM API style must be openai or anthropic");
}

export function isLlmApiStyle(value: unknown): value is LlmApiStyle {
  return value === "openai" || value === "anthropic";
}
