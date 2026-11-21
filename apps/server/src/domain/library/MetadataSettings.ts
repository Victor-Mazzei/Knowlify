/** Maximum length accepted for the Google Books API key. */
export const METADATA_KEY_MAX_CHARS = 256;

/** Keys travel in an HTTP header, so only visible ASCII without spaces is safe. */
const KEY_PATTERN = /^[\x21-\x7E]+$/;

export type MetadataSettingsErrorCode =
  | "invalid_settings"
  | "invalid_google_books_key"
  | "metadata_locked"
  | "rate_limited";

/** A rejected metadata-settings request; the route maps status, code and field. */
export class MetadataSettingsError extends Error {
  constructor(
    readonly code: MetadataSettingsErrorCode,
    readonly status: 400 | 403 | 429,
    message: string,
    readonly field?: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "MetadataSettingsError";
  }
}

/**
 * Validates a Google Books key without ever echoing it. The message is fixed for
 * each rule so callers can branch on `field` and tests can assert no key leaks.
 */
export function normalizeGoogleBooksKey(raw: unknown): string {
  const invalid = (message: string): never => {
    throw new MetadataSettingsError("invalid_google_books_key", 400, message, "googleBooksKey");
  };
  if (typeof raw !== "string") return invalid("The Google Books key must be a string");
  if (raw.length === 0) return invalid("Provide a Google Books key, or send null to remove the saved key");
  if (raw.length > METADATA_KEY_MAX_CHARS) {
    return invalid(`The Google Books key must be ${METADATA_KEY_MAX_CHARS} characters or fewer`);
  }
  if (!KEY_PATTERN.test(raw)) {
    return invalid("The Google Books key can only use printable ASCII characters, without spaces");
  }
  return raw;
}
