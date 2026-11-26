import { compareVersions, isKnownVersion, parseVersion, type Version } from "./Version.js";

/** Owner/repository are constants: no environment can redirect the outbound request. */
const UPDATE_REPOSITORY = "Victor-Mazzei/Knowlify";

/** GitHub's `releases/latest` ignores drafts and prereleases; the published release wins. */
export const RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;

const RELEASE_PAGE_BASE = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/`;
const MAX_TAG_CHARS = 64;

/** Only a final release (`vX.Y.Z`) may reach the UI; prereleases are never announced. */
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ReleaseTag {
  readonly tag: string;
  readonly version: Version;
}

/**
 * Validates a `tag_name` from the releases API. Anything outside `vMAJOR.MINOR.PATCH`
 * (including `latest`, `v1.2`, `2.5.0`, `v1.2.3+build` and prereleases) is ignored.
 */
export function parseReleaseTag(raw: unknown): ReleaseTag | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TAG_CHARS) return null;
  if (!RELEASE_TAG_PATTERN.test(raw)) return null;
  const version = parseVersion(raw.slice(1));
  if (version === null || version.prerelease.length > 0) return null;
  return { tag: raw, version };
}

/** The release page is built from the validated tag, never from the provider's URL. */
export function releaseUrl(release: ReleaseTag): string {
  return `${RELEASE_PAGE_BASE}${release.tag}`;
}

/** `latest > current`; an unknown, unparsable or equal current version never announces. */
export function isNewerRelease(currentVersion: string, latest: ReleaseTag | null): boolean {
  if (latest === null || !isKnownVersion(currentVersion)) return false;
  const current = parseVersion(currentVersion);
  if (current === null) return false;
  return compareVersions(latest.version, current) > 0;
}
