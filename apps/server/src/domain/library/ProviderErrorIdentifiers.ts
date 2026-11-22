/**
 * Closed allowlists for provider-supplied diagnostics.
 *
 * A metadata provider controls `error.status` and `details[].reason`; either field can
 * echo the API key or the user's query. Only documented, stable identifiers cross these
 * maps, canonicalized to the spelling used in logs. Anything else is dropped and the
 * HTTP status alone classifies the failure.
 */

const ERROR_STATUSES = [
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;

const ERROR_REASONS = [
  // Generic buckets Google uses instead of the actionable identifier.
  "badRequest",
  "forbidden",
  "failedPrecondition",
  // API key and service restrictions.
  "API_KEY_INVALID",
  "API_KEY_EXPIRED",
  "API_KEY_NOT_VALID",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_ANDROID_APP_BLOCKED",
  "API_KEY_IOS_APP_BLOCKED",
  "IP_REFERER_BLOCKED",
  "keyInvalid",
  "keyExpired",
  "SERVICE_DISABLED",
  "accessNotConfigured",
  // Quota and transport buckets seen in real responses.
  "rateLimitExceeded",
  "dailyLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "backendError",
  "internalError",
  "authError",
  "accessDenied",
] as const;

const MAX_IDENTIFIER_LENGTH = 64;

const index = <T extends string>(values: readonly T[]): ReadonlyMap<string, T> =>
  new Map(values.map((value) => [value.toLowerCase(), value]));

const statuses = index(ERROR_STATUSES);
const reasons = index(ERROR_REASONS);

const known = (values: ReadonlyMap<string, string>, value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IDENTIFIER_LENGTH) return undefined;
  return values.get(trimmed.toLowerCase());
};

/** Google `error.status`, only when it is one of the known safe identifiers. */
export const knownProviderErrorStatus = (value: unknown): string | undefined => known(statuses, value);

/** Google `errors[].reason`/`details[].reason`, only when it is a known safe identifier. */
export const knownProviderErrorReason = (value: unknown): string | undefined => known(reasons, value);
