import { describe, expect, it } from "vitest";
import { releaseUrl } from "./linkPolicy";

const VALID = "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0";

describe("releaseUrl", () => {
  it("keeps the official release page", () => {
    expect(releaseUrl(VALID)).toBe(VALID);
    expect(releaseUrl("https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0-rc.1")).toBe(
      "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0-rc.1",
    );
  });

  it.each([
    ["http", "http://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0"],
    ["another host", "https://example.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0"],
    ["lookalike host", "https://github.com.example.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0"],
    ["subdomain", "https://www.github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0"],
    ["other repository", "https://github.com/other/repo/releases/tag/v2.5.0"],
    ["other path", "https://github.com/Victor-Mazzei/Knowlify/releases/latest"],
    ["extra segment", "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0/extra"],
    ["query", `${VALID}?download=1`],
    ["hash", `${VALID}#notes`],
    ["credentials", "https://user:pass@github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0"],
    ["tag without v", "https://github.com/Victor-Mazzei/Knowlify/releases/tag/2.5.0"],
    ["loose tag", "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5"],
    ["build metadata", "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0+build"],
    ["javascript", "javascript:alert(1)"],
    ["relative", "/Victor-Mazzei/Knowlify/releases/tag/v2.5.0"],
  ])("rejects %s", (_name, value) => {
    expect(releaseUrl(value)).toBeNull();
  });

  it("rejects empty and oversized values", () => {
    expect(releaseUrl(null)).toBeNull();
    expect(releaseUrl(undefined)).toBeNull();
    expect(releaseUrl("")).toBeNull();
    expect(releaseUrl(`${VALID}${"a".repeat(300)}`)).toBeNull();
  });
});
