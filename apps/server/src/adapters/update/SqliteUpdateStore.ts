import { parseReleaseTag } from "../../domain/update/ReleaseTag.js";
import { emptyUpdateState, type UpdateState } from "../../domain/update/UpdateState.js";
import type { UpdateConfigStore, UpdateStateStore } from "../../ports/update.js";
import type { Db } from "../storage/db.js";

const CONFIG_KEY = "update_check_enabled";
const STATE_KEY = "update_state";

/** Same shape accepted from GitHub; the value travels back in `If-None-Match`. */
const ETAG_PATTERN = /^(?:W\/)?"[\x21-\x7E]{1,200}"$/;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const timestamp = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : null;

const row = (db: Db, key: string): string | undefined =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)
    ?.value;

const put = (db: Db, key: string, value: string): void => {
  db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
};

/** The user toggle lives beside the other settings; `null` removes the override. */
export class SqliteUpdateConfigStore implements UpdateConfigStore {
  constructor(private readonly db: Db) {}

  load(): boolean | null {
    const value = row(this.db, CONFIG_KEY);
    if (value === "on") return true;
    if (value === "off") return false;
    return null;
  }

  save(enabled: boolean | null): void {
    if (enabled === null) {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(CONFIG_KEY);
      return;
    }
    put(this.db, CONFIG_KEY, enabled ? "on" : "off");
  }
}

/** One JSON row; a malformed record is treated as "never checked" instead of failing boot. */
export class SqliteUpdateStateStore implements UpdateStateStore {
  constructor(private readonly db: Db) {}

  load(): UpdateState | null {
    const raw = row(this.db, STATE_KEY);
    if (raw === undefined) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isRecord(value)) return null;
    const latestTag = typeof value.latestTag === "string" && parseReleaseTag(value.latestTag) !== null
      ? value.latestTag
      : null;
    const etag = typeof value.etag === "string" && ETAG_PATTERN.test(value.etag) ? value.etag : null;
    const checkedAt = timestamp(value.checkedAt);
    const nextAttemptAt = timestamp(value.nextAttemptAt);
    const failures = typeof value.failures === "number"
      && Number.isInteger(value.failures) && value.failures >= 0 && value.failures <= 16
      ? value.failures
      : 0;
    if (latestTag === null && etag === null && checkedAt === null && nextAttemptAt === null && failures === 0) {
      return emptyUpdateState();
    }
    return { latestTag, etag, checkedAt, nextAttemptAt, failures };
  }

  save(state: UpdateState): void {
    put(this.db, STATE_KEY, JSON.stringify(state));
  }

  clear(): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(STATE_KEY);
  }
}
