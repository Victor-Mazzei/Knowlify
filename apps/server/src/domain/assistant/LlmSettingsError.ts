export type LlmSettingsErrorCode =
  | "invalid_url"
  | "url_blocked"
  | "https_required"
  | "key_required"
  | "invalid_value"
  | "invalid_header"
  | "header_value_required"
  | "llm_locked"
  | "rate_limited";

/** Which part of a custom header failed, so the UI can focus the right input. */
export type LlmHeaderErrorField = "name" | "value";

/**
 * A configuration failure with an HTTP status and a stable code. Messages may name a
 * header (the user typed it) but must never contain a header value or the API key.
 */
export class LlmSettingsError extends Error {
  constructor(
    readonly code: LlmSettingsErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
    readonly field?: LlmHeaderErrorField,
  ) {
    super(message);
    this.name = "LlmSettingsError";
  }
}
