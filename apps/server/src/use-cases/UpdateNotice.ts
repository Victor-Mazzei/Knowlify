import { isNewerRelease, parseReleaseTag, releaseUrl } from "../domain/update/ReleaseTag.js";
import { emptyUpdateState, type UpdateState } from "../domain/update/UpdateState.js";
import { UpdateError } from "../domain/update/UpdateError.js";
import type {
  ReleaseFetchResult,
  ReleaseSource,
  UpdateConfigStore,
  UpdateFailureReason,
  UpdateStateStore,
} from "../ports/update.js";
import type { Clock, Logger } from "../ports/index.js";

const DEFAULT_ENABLED = true;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MIN_BACKOFF_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURES = 16;

export interface UpdateNoticeOptions {
  /** Running build version, from the packaged manifest (`/api/about` uses the same). */
  currentVersion: string;
  /** `KNOWLIFY_UPDATE_CHECK`; `null` when the operator never set it. */
  env: { enabled: boolean | null };
  /** `KNOWLIFY_UPDATE_LOCKED`: the environment wins and the toggle answers 403. */
  locked: boolean;
  source: ReleaseSource;
  stateStore: UpdateStateStore;
  configStore: UpdateConfigStore;
  clock?: Clock;
  log?: Logger;
  /** Test seams; production keeps the documented 24 h and 60 s. */
  checkIntervalMs?: number;
  cooldownMs?: number;
}

export interface UpdateView {
  enabled: boolean;
  locked: boolean;
  canManage: boolean;
  current: string;
  latest: { version: string; url: string } | null;
  available: boolean;
  checkedAt: string | null;
}

export type UpdateSource = "default" | "env" | "db";

export interface UpdateSettingsView {
  enabled: boolean;
  locked: boolean;
  source: UpdateSource;
}

const invalidBody = (): never => {
  throw new UpdateError("invalid_body", 400, "The body must be {\"enabled\": true} or {\"enabled\": false}");
};

/** Exactly one boolean field; the value is never echoed, and an empty body is invalid. */
function normalizeEnabled(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalidBody();
  const body = raw as Record<string, unknown>;
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "enabled" || typeof body.enabled !== "boolean") {
    return invalidBody();
  }
  return body.enabled;
}

const isFinitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Update notice (release 2.5.0): lazy 24 h cache, single-flight, failure backoff and the
 * saved/seed/locked toggle. It never contacts the network on boot or on a timer: only a
 * `GET /api/update` (after the cache ages) or an explicit "Check now" may fetch.
 */
export class UpdateNotice {
  private state: UpdateState = emptyUpdateState();
  private storedEnabled: boolean | null = null;
  private inFlight: Promise<void> | null = null;
  private lastAttemptAt: number | null = null;
  private lastFailureReason: UpdateFailureReason | null = null;
  /** Bumped by every saved toggle; a check started under an older generation is discarded. */
  private settingsGeneration = 0;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly cooldownMs: number;

  constructor(private readonly options: UpdateNoticeOptions) {
    const clock = options.clock;
    this.now = clock ? () => clock.now() : Date.now;
    this.intervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
  }

  /** Reads the toggle and the last cached result once; no network, no timer. */
  bootstrap(): void {
    this.storedEnabled = this.options.locked ? null : this.options.configStore.load();
    this.state = this.options.stateStore.load() ?? emptyUpdateState();
  }

  isEnabled(): boolean {
    if (this.options.locked) return this.options.env.enabled ?? DEFAULT_ENABLED;
    return this.storedEnabled ?? this.options.env.enabled ?? DEFAULT_ENABLED;
  }

  /** `GET /api/settings/update`: effective value plus where it came from. */
  settings(): UpdateSettingsView {
    return {
      enabled: this.isEnabled(),
      locked: this.options.locked,
      source: this.source(),
    };
  }

  /** `PUT /api/settings/update`; turning it off also discards the cached release. */
  updateSettings(raw: unknown): UpdateSettingsView {
    if (this.options.locked) {
      throw new UpdateError("update_locked", 403, "Update settings are managed by the server environment");
    }
    const enabled = normalizeEnabled(raw);
    // Persist before touching memory: a failed write must not leave the two disagreeing.
    this.options.configStore.save(enabled);
    this.storedEnabled = enabled;
    // The cache belongs to the previous setting; an in-flight check must not refill it.
    this.settingsGeneration += 1;
    if (!enabled) this.clearState();
    return this.settings();
  }

  /**
   * Never blocks on the network: returns the current cache and may schedule one refresh.
   * Only a peer allowed to manage the check may start it: a remote LAN peer reads the
   * cached state with `canManage:false` and must not make the server contact GitHub.
   */
  view(canManage: boolean): UpdateView {
    const snapshot = this.snapshot(canManage);
    if (canManage) this.scheduleLazyRefresh();
    return snapshot;
  }

  /**
   * "Check now" awaits the real exchange. The 24 h interval is bypassed, but the 60 s
   * cooldown and a failure backoff still gate the call, and concurrent calls share one
   * in-flight request.
   */
  async checkNow(canManage: boolean): Promise<UpdateView> {
    if (!this.isEnabled()) return this.snapshot(canManage);
    if (this.inFlight !== null) {
      await this.inFlight;
      return this.snapshot(canManage);
    }
    const now = this.now();
    if (this.state.nextAttemptAt !== null && now < this.state.nextAttemptAt) {
      return this.snapshot(canManage);
    }
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.cooldownMs) {
      return this.snapshot(canManage);
    }
    await this.refresh();
    return this.snapshot(canManage);
  }

  private source(): UpdateSource {
    if (!this.options.locked && this.storedEnabled !== null) return "db";
    return this.options.env.enabled === null ? "default" : "env";
  }

  private snapshot(canManage: boolean): UpdateView {
    const base = {
      enabled: this.isEnabled(),
      locked: this.options.locked,
      canManage,
      current: this.options.currentVersion,
    };
    if (!base.enabled) {
      return { ...base, latest: null, available: false, checkedAt: null };
    }
    const release = this.state.latestTag === null ? null : parseReleaseTag(this.state.latestTag);
    return {
      ...base,
      latest: release === null
        ? null
        : { version: release.tag.slice(1), url: releaseUrl(release) },
      available: isNewerRelease(this.options.currentVersion, release),
      checkedAt: this.state.checkedAt === null ? null : new Date(this.state.checkedAt).toISOString(),
    };
  }

  private scheduleLazyRefresh(): void {
    if (!this.isEnabled() || this.inFlight !== null) return;
    const now = this.now();
    const due = this.state.checkedAt === null ? 0 : this.state.checkedAt + this.intervalMs;
    const blockedUntil = Math.max(due, this.state.nextAttemptAt ?? 0);
    if (now < blockedUntil) return;
    void this.refresh();
  }

  /** Single-flight: every caller shares the promise created by the first attempt. */
  private refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    if (!this.isEnabled()) return Promise.resolve();
    const run = this.runCheck()
      .catch(() => {
        this.options.log?.warn?.("update check failed reason=network");
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private async runCheck(): Promise<void> {
    const now = this.now();
    // Captured before the await: a toggle while the request is in flight invalidates it.
    const generation = this.settingsGeneration;
    this.lastAttemptAt = now;
    let result: ReleaseFetchResult;
    try {
      result = await this.options.source.latest(this.state.etag);
    } catch {
      // A source contract violation still fails silently; nothing from the error is read.
      result = { outcome: "failed", reason: "network" };
    }

    // Turning the check off discards the cache; a response started before that toggle
    // (even if the user turned it back on) must not repopulate memory or SQLite.
    if (generation !== this.settingsGeneration) return;

    if (result.outcome === "ok") {
      this.lastFailureReason = null;
      this.save({
        latestTag: result.release.tag,
        etag: result.etag,
        checkedAt: now,
        nextAttemptAt: null,
        failures: 0,
      });
      return;
    }
    if (result.outcome === "not_modified") {
      this.lastFailureReason = null;
      this.save({
        ...this.state,
        etag: result.etag ?? this.state.etag,
        checkedAt: now,
        nextAttemptAt: null,
        failures: 0,
      });
      return;
    }
    this.applyFailure(result, now);
  }

  private applyFailure(
    result: Extract<ReleaseFetchResult, { outcome: "failed" }>,
    now: number,
  ): void {
    const failures = Math.min(this.state.failures + 1, MAX_FAILURES);
    const exponential = Math.min(
      MAX_BACKOFF_MS,
      MIN_BACKOFF_MS * 2 ** Math.min(failures - 1, 5),
    );
    // A server-provided wait wins, bounded to [1 h, 24 h]; without one the backoff doubles.
    const wait = isFinitePositive(result.retryAfterMs)
      ? Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, result.retryAfterMs))
      : exponential;
    this.save({ ...this.state, failures, nextAttemptAt: now + wait });
    if (this.lastFailureReason === result.reason) return;
    this.lastFailureReason = result.reason;
    const status = typeof result.status === "number" ? ` status=${result.status}` : "";
    this.options.log?.warn?.(`update check failed reason=${result.reason}${status}`);
  }

  private save(state: UpdateState): void {
    this.state = state;
    try {
      this.options.stateStore.save(state);
    } catch {
      // A read-only or busy database must not turn a silent check into a request error.
      this.options.log?.warn?.("update check state could not be saved");
    }
  }

  private clearState(): void {
    this.state = emptyUpdateState();
    this.lastFailureReason = null;
    try {
      this.options.stateStore.clear();
    } catch {
      this.options.log?.warn?.("update check state could not be cleared");
    }
  }
}
