import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Runtime identity exposed by GET /api/about (ADR-3/ADR-5). */
export interface BuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
  /** Repository URL of the running build, when the image was built with one. */
  sourceUrl: string | null;
  node: string;
}

export const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * Lowercase SHA fragment produced by the image build. The source may carry the full
 * 40-char revision; the API reports the conventional 7-char prefix.
 */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Full ISO-8601 timestamp with a timezone. A bare date (`2026-11-07`) is not a build
 * timestamp, and `Date.parse` alone would also accept human formats such as "March 5".
 */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `package.json` ships one level above `dist` (and above `src`), so the same relative
 * path works under tsx, Vitest and the compiled server used by Docker and the desktop.
 */
export const SERVER_PACKAGE_JSON_URL = new URL("../../../package.json", import.meta.url);

export interface BuildInfoOptions {
  env?: NodeJS.ProcessEnv;
  packageJsonUrl?: URL;
  /** Node version without the leading `v` (defaults to `process.versions.node`). */
  nodeVersion?: string;
  warn?: (message: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads the packaged manifest; a missing or malformed file must never block startup. */
export function readVersion(
  packageJsonUrl: URL = SERVER_PACKAGE_JSON_URL,
  warn?: (message: string) => void,
): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
    if (isRecord(manifest) && typeof manifest.version === "string" && manifest.version.trim() !== "") {
      return manifest.version.trim();
    }
    warn?.(`[about] ${fileURLToPath(packageJsonUrl)} has no version; reporting ${UNKNOWN_VERSION}`);
  } catch {
    warn?.(`[about] could not read ${fileURLToPath(packageJsonUrl)}; reporting ${UNKNOWN_VERSION}`);
  }
  return UNKNOWN_VERSION;
}

/** Returns the 7-char revision or `null` for anything outside the frozen hex format. */
export function parseBuildCommit(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  return COMMIT_PATTERN.test(raw) ? raw.slice(0, 7) : null;
}

/** Returns an ISO timestamp normalised to UTC, or `null` when the value is not valid ISO-8601. */
export function parseBuildDate(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!ISO_TIMESTAMP_PATTERN.test(raw)) return null;
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

const MAX_SOURCE_URL_CHARS = 2_048;

/** A plain HTTP(S) repository URL without credentials; anything else is not a source link. */
export function parseSourceUrl(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw || raw.length > MAX_SOURCE_URL_CHARS) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function loadBuildInfo(options: BuildInfoOptions = {}): BuildInfo {
  const {
    env = process.env,
    packageJsonUrl = SERVER_PACKAGE_JSON_URL,
    nodeVersion = process.versions.node,
    warn,
  } = options;
  const commit = parseBuildCommit(env.KNOWLIFY_BUILD_COMMIT);
  const builtAt = parseBuildDate(env.KNOWLIFY_BUILD_DATE);
  const sourceUrl = parseSourceUrl(env.KNOWLIFY_SOURCE_URL);
  if (env.KNOWLIFY_BUILD_COMMIT?.trim() && commit === null) {
    warn?.("[about] KNOWLIFY_BUILD_COMMIT is invalid; reporting no commit");
  }
  if (env.KNOWLIFY_BUILD_DATE?.trim() && builtAt === null) {
    warn?.("[about] KNOWLIFY_BUILD_DATE is invalid; reporting no build date");
  }
  if (env.KNOWLIFY_SOURCE_URL?.trim() && sourceUrl === null) {
    warn?.("[about] KNOWLIFY_SOURCE_URL is invalid; reporting no source URL");
  }
  return { version: readVersion(packageJsonUrl, warn), commit, builtAt, sourceUrl, node: nodeVersion };
}
