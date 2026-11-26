import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isDismissedVersion,
  isReleaseVersion,
} from "./updateVersion";

describe("updateVersion", () => {
  it("compares the numeric core", () => {
    expect(compareVersions("2.4.10", "2.4.9")).toBeGreaterThan(0);
    expect(compareVersions("2.4.9", "2.4.10")).toBeLessThan(0);
    expect(compareVersions("2.4.100", "2.4.99")).toBeGreaterThan(0);
    expect(compareVersions("2.4.0", "2.4.0")).toBe(0);
  });

  it("compares cores beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(
      compareVersions("9007199254740993.0.0", "9007199254740992.0.0"),
    ).toBeGreaterThan(0);
    expect(
      compareVersions("9007199254740992.0.0", "9007199254740993.0.0"),
    ).toBeLessThan(0);
    expect(compareVersions("9007199254740993.0.0", "9007199254740993.0.0")).toBe(0);
    expect(
      compareVersions("18446744073709551617.0.0", "18446744073709551616.0.0"),
    ).toBeGreaterThan(0);
  });

  it("treats a prerelease as lower than its release and orders identifiers", () => {
    expect(compareVersions("2.5.0-rc.1", "2.5.0")).toBeLessThan(0);
    expect(compareVersions("2.5.0", "2.5.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("2.5.0-rc.2", "2.5.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("2.5.0-rc.10", "2.5.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("2.5.0-rc.100", "2.5.0-rc.99")).toBeGreaterThan(0);
    expect(compareVersions("2.5.0-2", "2.5.0-alpha")).toBeLessThan(0);
    expect(compareVersions("2.5.0-alpha", "2.5.0-alpha.1")).toBeLessThan(0);
  });

  it("compares prerelease numbers beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(
      compareVersions("2.5.0-rc.9007199254740993", "2.5.0-rc.9007199254740992"),
    ).toBeGreaterThan(0);
    expect(
      compareVersions("2.5.0-rc.9007199254740992", "2.5.0-rc.9007199254740993"),
    ).toBeLessThan(0);
    expect(
      compareVersions("2.5.0-9007199254740993", "2.5.0-9007199254740992"),
    ).toBeGreaterThan(0);
    expect(
      compareVersions("2.5.0-rc.9007199254740993", "2.5.0-rc.9007199254740993"),
    ).toBe(0);
  });

  it("rejects loose or build-tagged versions", () => {
    for (const value of [
      "2.5",
      "v2.5.0",
      "2.5.0+build",
      "01.2.3",
      "2.05.0",
      "2.5.0-",
      "2.5.0-01",
      "2.5.0-alpha.01",
      "",
    ]) {
      expect(isReleaseVersion(value)).toBe(false);
      expect(compareVersions(value, "2.5.0")).toBeNull();
    }
    expect(isReleaseVersion("2.5.0")).toBe(true);
    expect(isReleaseVersion("2.5.0-rc.1")).toBe(true);
    expect(isReleaseVersion("2.5.0-0")).toBe(true);
    expect(isReleaseVersion("2.5.0-alpha.1")).toBe(true);
  });

  it("never hides a newer release after dismissing a smaller one", () => {
    // Regression: Number() rounded both cores to the same double.
    expect(isDismissedVersion("9007199254740993.0.0", "9007199254740992.0.0")).toBe(false);
    expect(isDismissedVersion("9007199254740992.0.0", "9007199254740993.0.0")).toBe(true);
    expect(
      isDismissedVersion(
        "2.5.0-rc.9007199254740993",
        "2.5.0-rc.9007199254740992",
      ),
    ).toBe(false);
    expect(
      isDismissedVersion(
        "2.5.0-rc.9007199254740992",
        "2.5.0-rc.9007199254740993",
      ),
    ).toBe(true);
  });

  it("hides equal or older releases and surfaces a newer one", () => {
    expect(isDismissedVersion("2.5.0", "2.5.0")).toBe(true);
    expect(isDismissedVersion("2.4.9", "2.5.0")).toBe(true);
    expect(isDismissedVersion("2.5.0", "2.5.1")).toBe(true);
    expect(isDismissedVersion("2.5.1", "2.5.0")).toBe(false);
    expect(isDismissedVersion("2.5.0", "2.5.0-rc.1")).toBe(false);
    expect(isDismissedVersion("2.5.0", null)).toBe(false);
    expect(isDismissedVersion("2.5.0", "not-a-version")).toBe(false);
  });
});
