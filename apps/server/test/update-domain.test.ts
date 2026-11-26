import { describe, expect, it } from "vitest";
import {
  UNKNOWN_VERSION,
  compareVersions,
  parseVersion,
} from "../src/domain/update/Version.js";
import {
  isNewerRelease,
  parseReleaseTag,
  releaseUrl,
} from "../src/domain/update/ReleaseTag.js";

const version = (text: string) => {
  const parsed = parseVersion(text);
  expect(parsed, text).not.toBeNull();
  return parsed!;
};

const tag = (text: string) => {
  const parsed = parseReleaseTag(text);
  expect(parsed, text).not.toBeNull();
  return parsed!;
};

describe("SemVer precedence", () => {
  it("compares the numeric core as integers, not as text", () => {
    expect(compareVersions(version("2.4.10"), version("2.4.9"))).toBeGreaterThan(0);
    expect(compareVersions(version("2.4.9"), version("2.4.10"))).toBeLessThan(0);
    expect(compareVersions(version("10.0.0"), version("9.99.99"))).toBeGreaterThan(0);
    expect(compareVersions(version("2.5.0"), version("2.5.0"))).toBe(0);
  });

  it("orders prereleases below the release and by the SemVer rules", () => {
    expect(compareVersions(version("2.5.0-rc.1"), version("2.5.0"))).toBeLessThan(0);
    expect(compareVersions(version("2.5.0"), version("2.5.0-rc.1"))).toBeGreaterThan(0);
    expect(compareVersions(version("2.5.0-rc.2"), version("2.5.0-rc.1"))).toBeGreaterThan(0);
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    expect(compareVersions(version("2.5.0-1"), version("2.5.0-alpha"))).toBeLessThan(0);
    // A larger set wins when all shared identifiers are equal.
    expect(compareVersions(version("2.5.0-alpha"), version("2.5.0-alpha.1"))).toBeLessThan(0);
    expect(compareVersions(version("2.5.0-alpha.1"), version("2.5.0-alpha.beta"))).toBeLessThan(0);
    expect(compareVersions(version("2.5.0-rc.10"), version("2.5.0-rc.9"))).toBeGreaterThan(0);
  });

  it("accepts only strict SemVer without build metadata or leading zeros", () => {
    expect(parseVersion("2.4.0")).not.toBeNull();
    expect(parseVersion("2.4.0-rc.1")).not.toBeNull();
    expect(parseVersion("1.2.3-alpha-beta")).toMatchObject({ prerelease: ["alpha-beta"] });
    for (const invalid of ["", "2", "2.4", "v2.4.0", "2.4.0+build", "2.4.0-", "2.4.0-01", "01.2.3", "2.4.0 rc"]) {
      expect(parseVersion(invalid), invalid).toBeNull();
    }
  });
});

describe("release tags", () => {
  it("accepts only final vX.Y.Z tags", () => {
    expect(tag("v2.5.0")).toMatchObject({ tag: "v2.5.0" });
    expect(tag("v2.5.0").version).toMatchObject({ major: "2", minor: "5", patch: "0", prerelease: [] });
    for (const invalid of [
      "latest",
      "v1.2",
      "2.5.0",
      "version-2.5.0",
      "v1.2.3+build",
      "v01.2.3",
      "v1.02.3",
      "v1.2.03",
      "v2.5.0-rc.1",
      "v2.5.0-rc1",
      "v2.5.0 ",
      `v2.5.0-${"a".repeat(80)}`,
    ]) {
      expect(parseReleaseTag(invalid), invalid).toBeNull();
    }
    expect(parseReleaseTag(undefined)).toBeNull();
    expect(parseReleaseTag(250)).toBeNull();
  });

  it("builds the release page from the validated tag", () => {
    const release = tag("v2.5.0");
    expect(releaseUrl(release)).toBe("https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0");
  });

  it("announces only a strictly newer final release", () => {
    expect(isNewerRelease("2.4.0", tag("v2.5.0"))).toBe(true);
    expect(isNewerRelease("2.4.9", tag("v2.4.10"))).toBe(true);
    expect(isNewerRelease("2.5.0", tag("v2.5.0"))).toBe(false);
    expect(isNewerRelease("2.6.0", tag("v2.5.0"))).toBe(false);
    expect(isNewerRelease("2.5.0-rc.1", tag("v2.5.0"))).toBe(true);
    expect(isNewerRelease(UNKNOWN_VERSION, tag("v2.5.0"))).toBe(false);
    expect(isNewerRelease("not-a-version", tag("v2.5.0"))).toBe(false);
    expect(isNewerRelease("2.4.0", null)).toBe(false);
  });
});
