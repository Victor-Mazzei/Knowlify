import type { LlmApiStyle } from "./llmTypes";

export type LlmStyleProfile = {
  /** Visible description next to the selector. */
  styleHelp: string;
  urlPlaceholder: string;
  urlHelp: string;
  keyHelp: string;
  modelPlaceholder: string;
  modelHelp: string;
  managedHelp: string;
  maxTokensWarning: string;
  notFound: string;
};

export const LLM_API_STYLES: readonly { value: LlmApiStyle; label: string }[] = [
  { value: "openai", label: "OpenAI-compatible (chat completions)" },
  { value: "anthropic", label: "Anthropic (Messages API)" },
];

export const LLM_STYLE_PROFILES: Record<LlmApiStyle, LlmStyleProfile> = {
  openai: {
    styleHelp: "The server calls the chat completions API.",
    urlPlaceholder: "https://api.example.com/v1",
    urlHelp: "OpenAI-compatible base URL, including /v1 when the provider needs it.",
    keyHelp: "Sent as the Authorization header and stored encrypted on the server.",
    modelPlaceholder: "Model name",
    modelHelp: "",
    managedHelp: "Authorization and Content-Type are managed by Knowlify. User-Agent can be overridden.",
    maxTokensWarning: "",
    notFound: "No OpenAI-compatible API was found at this URL.",
  },
  anthropic: {
    styleHelp: "The server calls the Messages API.",
    urlPlaceholder: "https://api.anthropic.com",
    urlHelp: "Anthropic base URL without /v1. The server adds /v1/messages.",
    keyHelp: "Sent as the x-api-key header and stored encrypted on the server.",
    modelPlaceholder: "claude-sonnet-5-5",
    modelHelp: "Example: claude-sonnet-5-5.",
    managedHelp:
      "x-api-key, Authorization and Content-Type are managed by Knowlify. anthropic-version defaults to 2023-06-01; add it here to override.",
    maxTokensWarning: "Reasoning models count thinking toward Max tokens; use 4096 or more.",
    notFound: "No Anthropic Messages API was found at this URL.",
  },
};

/** Headers the server owns, independent of the API style (D4). */
export const BASE_FORBIDDEN_HEADERS: readonly string[] = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "content-type",
  "content-encoding",
  "accept",
  "accept-encoding",
  "cookie",
  "set-cookie",
  "authorization",
];

/** Returns why the name cannot be set by the user, or null when it is free. */
export function managedHeaderReason(name: string, style: LlmApiStyle): string | null {
  const lower = name.toLowerCase();
  if (style === "anthropic" && lower === "x-api-key") {
    return "is managed by the Anthropic API style";
  }
  if (lower.startsWith(":") || lower.startsWith("proxy-") || lower.startsWith("sec-")) {
    return "is reserved";
  }
  // Accept, Accept-Encoding, Accept-Language, Accept-Charset and any other Accept*
  // are controlled by the server's content negotiation.
  if (lower.startsWith("accept")) return "is managed by Knowlify";
  if (BASE_FORBIDDEN_HEADERS.includes(lower)) return "is managed by Knowlify";
  return null;
}
