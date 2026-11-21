/**
 * HTTP contract types for the About card (`GET /api/about`).
 * Mirrors docs/planner/2026-11-07-app-version-semver.md.
 * Keep this module free of server imports and runtime logic.
 */

/** Build details reported by the app server; commit and build time are null outside builds. */
export type AboutInfo = {
  version: string;
  commit: string | null;
  builtAt: string | null;
  node: string;
  /** Public repository URL. Older servers omit it; only http(s) links are rendered. */
  sourceUrl?: string | null;
};
