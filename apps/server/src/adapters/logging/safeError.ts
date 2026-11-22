/**
 * Provider and library failures may carry a URL, a filesystem path, a key or the user's
 * query in `message`, `stack` or `cause`. Logs keep only a closed allowlist of stable
 * class names; the rest of the error is never serialized.
 */

const ERROR_NAMES: ReadonlySet<string> = new Set([
  // JavaScript/Node built-ins.
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "SystemError",
  // Fastify and third-party infrastructure.
  "FastifyError",
  "SqliteError",
  "ZodError",
  // Domain and adapter failures.
  "DomainError",
  "NotFoundError",
  "ValidationError",
  "ConflictError",
  "AccountError",
  "IndexingDisabledError",
  "JobAbandonedError",
  "PassageSearchDisabledError",
  "MetadataRateLimitError",
  "IngestError",
  "SecretUnavailableError",
  "MetadataProviderError",
  "CoverFetchError",
  "CoverImageError",
  "GuardedFetchError",
  "MetadataExtractionTimeoutError",
  "ChatDisabledError",
  "ConversationFullError",
  "ConversationScopeMismatchError",
  "LibraryChatUnavailableError",
  "ChatRateLimitedError",
  "TutorPromptError",
  "LlmSettingsError",
  "MetadataSettingsError",
  "MetadataDisabledError",
  "LlmError",
]);

const nameOf = (error: unknown): string | undefined => {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 && name.length <= 128 ? name : undefined;
  } catch {
    return undefined;
  }
};

/** A known error class name or the generic `Error`; never a provider-controlled string. */
export const safeErrorType = (error: unknown): string => {
  const name = nameOf(error);
  return name !== undefined && ERROR_NAMES.has(name) ? name : "Error";
};

/** Pino `err` serializer shape: no message, stack, cause or provider code ever leaves here. */
export const safeErrorForLog = (error: unknown): { type: string; message: string; stack: string } => ({
  type: safeErrorType(error),
  message: "[redacted]",
  stack: "[redacted]",
});
