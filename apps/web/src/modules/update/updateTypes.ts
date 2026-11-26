/**
 * HTTP contract types for the update notice.
 * Mirrors docs/planner/2026-11-25-update-notice.md. Keep this module free of
 * server imports and runtime logic.
 */

/** The published release the server compares against its own version. */
export type ReleaseInfo = {
  version: string;
  /** Built by the server; revalidated by the web before it becomes a link. */
  url: string;
};

export type UpdateInfo = {
  enabled: boolean;
  /** The server environment decides; the switch is read-only. */
  locked: boolean;
  /** False for a remote peer when the server runs behind the LAN guard. */
  canManage: boolean;
  current: string;
  latest: ReleaseInfo | null;
  available: boolean;
  /** Last successful check, or null when the server never checked. */
  checkedAt: string | null;
};

export type UpdateSettingSource = "default" | "env" | "db";

export type UpdateSettings = {
  enabled: boolean;
  locked: boolean;
  source: UpdateSettingSource;
};
