import type { ReleaseTag } from "../domain/update/ReleaseTag.js";
import type { UpdateState } from "../domain/update/UpdateState.js";

/** Closed set of failure categories a log or a backoff decision may use. */
export type UpdateFailureReason =
  | "network"
  | "timeout"
  | "http_error"
  | "rate_limited"
  | "bad_response"
  | "bad_tag";

/**
 * Outcome of one `releases/latest` exchange. The adapter never throws for a remote
 * failure: a failed check must stay silent in the UI, and the use case owns backoff.
 */
export type ReleaseFetchResult =
  | { outcome: "ok"; release: ReleaseTag; etag: string | null }
  | { outcome: "not_modified"; etag: string | null }
  | {
    outcome: "failed";
    reason: UpdateFailureReason;
    /** HTTP status when the failure came from a response. */
    status?: number;
    /** Parsed `Retry-After`/`x-ratelimit-reset`; the use case clamps it to 1 h–24 h. */
    retryAfterMs?: number;
  };

/** Reads the latest published release; only `tag_name` (plus `draft`/`prerelease`) matters. */
export interface ReleaseSource {
  latest(etag: string | null): Promise<ReleaseFetchResult>;
}

/** One row in the `settings` table; a malformed value is treated as absent. */
export interface UpdateStateStore {
  load(): UpdateState | null;
  save(state: UpdateState): void;
  clear(): void;
}

/** User toggle; `null` means "never saved", so the environment seed or default applies. */
export interface UpdateConfigStore {
  load(): boolean | null;
  save(enabled: boolean | null): void;
}
