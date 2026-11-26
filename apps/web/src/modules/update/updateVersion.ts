/**
 * Strict SemVer helpers used by the update notice.
 *
 * The server already decides whether a release is newer. The web only compares
 * the release version with the one this browser dismissed, so both sides of
 * that comparison come from the server and never need build metadata.
 *
 * Version numbers are kept as decimal text: converting them to `number` loses
 * precision above `Number.MAX_SAFE_INTEGER`, which could hide a newer release.
 */

const CORE = "(0|[1-9]\\d*)";
// SemVer 2.0 prerelease identifier: numeric without a leading zero, or
// alphanumeric (digits allowed, but at least one letter or hyphen).
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION = new RegExp(
  `^${CORE}\\.${CORE}\\.${CORE}(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`,
);
const MAX_VERSION_LENGTH = 64;
const NUMERIC_IDENTIFIER = /^\d+$/;

type ParsedVersion = {
  core: [string, string, string];
  prerelease: string[] | null;
};

function parseVersion(value: string): ParsedVersion | null {
  if (!value || value.length > MAX_VERSION_LENGTH) return null;
  const match = VERSION.exec(value);
  if (!match) return null;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

/** Whether the value is a strict release version (`X.Y.Z` or `X.Y.Z-pre`). */
export function isReleaseVersion(value: string): boolean {
  return parseVersion(value) !== null;
}

/**
 * Digit strings are compared by length first, then lexicographically. Both
 * sides are validated decimal text without leading zeros, so this is exact for
 * any size.
 */
function compareNumericText(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (leftNumeric && rightNumeric) return compareNumericText(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left: string[] | null, right: string[] | null): number {
  // A release has higher precedence than any prerelease of the same core.
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = compareIdentifiers(left[index], right[index]);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** SemVer precedence; null when either value is not a strict version. */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.core.length; index += 1) {
    const difference = compareNumericText(a.core[index], b.core[index]);
    if (difference !== 0) return difference;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Whether a release is hidden because this browser already dismissed it.
 * A corrupt stored value never hides a notice; only an equal or newer
 * dismissal does, so a lower release surfaces again.
 */
export function isDismissedVersion(latest: string, dismissed: string | null): boolean {
  if (!dismissed) return false;
  const comparison = compareVersions(latest, dismissed);
  return comparison !== null && comparison <= 0;
}
