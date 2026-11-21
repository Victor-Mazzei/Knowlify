import type { IndexErrorCode } from "../../domain/knowledge/BookIndex.js";

/**
 * A failure the ingestion pipeline can classify. The domain maps the code to a
 * retry policy, so the message must stay short and free of secrets.
 */
export class IngestError extends Error {
  readonly code: IndexErrorCode;

  constructor(code: IndexErrorCode, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

export function isIngestError(value: unknown): value is IngestError {
  return value instanceof IngestError;
}

/** Turns any thrown value into a message that is safe to persist and log. */
export function describeFailure(error: unknown): { code: IndexErrorCode; message: string } {
  if (isIngestError(error)) return { code: error.code, message: error.message };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return { code: "unknown", message: "Operation timed out" };
    }
    return { code: "unknown", message: error.message.slice(0, 500) || "Unexpected error" };
  }
  return { code: "unknown", message: "Unexpected error" };
}
