/**
 * Strict semantic version used to compare the running build with the published
 * release. Build metadata (`+...`) is rejected on purpose: the product version is
 * also a Docker tag, and `+` is not valid there.
 */
export interface Version {
  /** Kept as decimal text so arbitrarily long numbers compare without precision loss. */
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  /** Empty for a release; identifiers keep their original text for precedence. */
  readonly prerelease: readonly string[];
}

/** Reported by `/api/about` for a build without a version; never announces an update. */
export const UNKNOWN_VERSION = "0.0.0-unknown";

const CORE = "(?:0|[1-9]\\d*)";
// SemVer 2.0 prerelease identifier: numeric without leading zeros, or alphanumeric
// (which may contain digits but never leading-zero numeric-only text).
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION_PATTERN = new RegExp(
  `^${CORE}\\.${CORE}\\.${CORE}(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?$`,
);
const MAX_VERSION_CHARS = 128;

const NUMERIC_IDENTIFIER = /^\d+$/;

/** Parses a strict SemVer 2.0 version; `null` for anything else (including `+build`). */
export function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_VERSION_CHARS) return null;
  if (!VERSION_PATTERN.test(raw)) return null;
  // A prerelease may itself contain hyphens (`1.2.3-alpha-beta`): split on the first one
  // only, never with a `split(..., 2)` limit, which would truncate the rest.
  const dash = raw.indexOf("-");
  const core = dash === -1 ? raw : raw.slice(0, dash);
  const prereleaseText = dash === -1 ? undefined : raw.slice(dash + 1);
  const [major, minor, patch] = core.split(".") as [string, string, string];
  return {
    major,
    minor,
    patch,
    prerelease: prereleaseText === undefined ? [] : prereleaseText.split("."),
  };
}

/** Digit strings are compared by length first, then lexicographically (no BigInt needed). */
function compareNumericText(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** SemVer 2.0 precedence: returns a negative number, zero or a positive number. */
export function compareVersions(left: Version, right: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const order = compareNumericText(left[key], right[key]);
    if (order !== 0) return order;
  }
  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  // A release has higher precedence than any prerelease of the same core.
  if (leftPre.length === 0 || rightPre.length === 0) {
    return leftPre.length === rightPre.length ? 0 : leftPre.length === 0 ? 1 : -1;
  }
  const shared = Math.min(leftPre.length, rightPre.length);
  for (let index = 0; index < shared; index += 1) {
    const leftId = leftPre[index]!;
    const rightId = rightPre[index]!;
    const leftNumeric = NUMERIC_IDENTIFIER.test(leftId);
    const rightNumeric = NUMERIC_IDENTIFIER.test(rightId);
    if (leftNumeric && rightNumeric) {
      const order = compareNumericText(leftId, rightId);
      if (order !== 0) return order;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  }
  return leftPre.length === rightPre.length ? 0 : leftPre.length < rightPre.length ? -1 : 1;
}

/** A build without a real version (`0.0.0-unknown`) never receives an update notice. */
export function isKnownVersion(raw: string): boolean {
  return raw !== UNKNOWN_VERSION && parseVersion(raw) !== null;
}
