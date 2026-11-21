/**
 * HTTP contract types for the LLM settings card (`/api/settings/llm`).
 * Mirrors docs/planner/2026-11-20-llm-custom-headers.md.
 * Keep this module free of server imports and runtime logic.
 */

export type LlmSource = "env" | "db" | "none";

export type LlmKeyState = "none" | "set" | "unreadable";

export type LlmApiStyle = "openai" | "anthropic";

export type LlmHeadersState = "none" | "set" | "unreadable";

/** Saved header names are public; values are secrets and never come back. */
export type LlmHeaderView = { name: string; hasValue: boolean };

/** An omitted `value` keeps the saved value for the same name and origin. */
export type LlmHeaderRequest = { name: string; value?: string };

export type LlmProbeCode =
  | "blocked"
  | "https_required"
  | "unreachable"
  | "timeout"
  | "tls"
  | "unauthorized"
  | "not_found"
  | "rejected"
  | "key_required";

/** Editable persona (`custom`) plus the fixed default and effective version. */
export type LlmPromptView = {
  custom: string | null;
  default: string;
  version: string;
  maxChars: number;
  locked: boolean;
};

/**
 * The connection view. The API-style and custom-header fields are additive; an
 * older server omits them and the UI hides those controls.
 */
export type LlmSettingsView = {
  source: LlmSource;
  locked: boolean;
  enabled: boolean;
  url: string | null;
  model: string | null;
  hasKey: boolean;
  keyState: LlmKeyState;
  maxTokens: number;
  timeoutSec: number;
  ratePerMin: number;
  defaults: { maxTokens: number; timeoutSec: number; ratePerMin: number };
  policy: { allowPrivate: "off" | "on" | "list"; publicRequiresHttps: true };
  prompt: LlmPromptView;
  apiStyle?: LlmApiStyle;
  headers?: LlmHeaderView[];
  headersState?: LlmHeadersState;
};

/** `PUT /api/settings/llm` response; the persona only comes from GET and its own route. */
export type LlmSettingsSaveResult = Omit<LlmSettingsView, "prompt">;

/** `PUT /api/settings/llm/prompt`; `null` restores the default persona. */
export type LlmPromptSaveRequest = { systemPrompt: string | null };

/** `PUT /api/settings/llm`; omitted fields keep the stored values. */
export type LlmSaveRequest = {
  url: string;
  model?: string | null;
  apiKey?: string;
  maxTokens?: number;
  timeoutSec?: number;
  ratePerMin?: number;
  apiStyle?: LlmApiStyle;
  headers?: LlmHeaderRequest[];
};

/** Draft sent to `models` and `test`; omitted fields use the effective configuration. */
export type LlmProbeRequest = {
  url?: string;
  apiKey?: string;
  model?: string;
  apiStyle?: LlmApiStyle;
  headers?: LlmHeaderRequest[];
};

export type LlmModelsResponse = {
  supported: boolean;
  models: string[];
  code?: LlmProbeCode;
};

export type LlmTestResponse = {
  ok: boolean;
  latencyMs: number;
  code?: LlmProbeCode;
  modelFound?: boolean;
};

export const LLM_DEFAULT_LIMITS = { maxTokens: 1024, timeoutSec: 120, ratePerMin: 20 } as const;

export const LLM_PROMPT_MAX_CHARS = 4000;

export const LLM_LIMITS = {
  maxTokens: { min: 1, max: 32768 },
  timeoutSec: { min: 5, max: 600 },
  ratePerMin: { min: 1, max: 120 },
} as const;
