/**
 * The single persisted row of the update notice. `checkedAt` is the last successful
 * check (200 or 304); `nextAttemptAt` gates the next real call after a failure and
 * `failures` drives the 1 h → 24 h backoff.
 */
export interface UpdateState {
  /** Validated release tag (`vX.Y.Z`); never provider free text. */
  readonly latestTag: string | null;
  readonly etag: string | null;
  readonly checkedAt: number | null;
  readonly nextAttemptAt: number | null;
  readonly failures: number;
}

export const emptyUpdateState = (): UpdateState => ({
  latestTag: null,
  etag: null,
  checkedAt: null,
  nextAttemptAt: null,
  failures: 0,
});
