export type UpdateErrorCode = "invalid_body" | "update_locked" | "rate_limited";

/** A rejected update-settings request; the routes map status, code and Retry-After. */
export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    readonly status: 400 | 403 | 429,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "UpdateError";
  }
}
