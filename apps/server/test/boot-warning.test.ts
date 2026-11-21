import { describe, expect, it } from "vitest";
import { defaultPasswordWarning } from "../src/config.js";

describe("default password boot warning", () => {
  it("warns once on a network bind while a seeded password is still active", () => {
    for (const password of ["admin", "change-this-password", ""]) {
      const warning = defaultPasswordWarning("0.0.0.0", password);
      expect(warning).toContain("KNOWLIFY_PASSWORD");
      expect(warning).not.toContain("\n");
      // The message is actionable without echoing the password itself.
      if (password !== "") expect(warning).not.toContain(password);
    }
  });

  it("stays silent with a real password or a loopback bind", () => {
    expect(defaultPasswordWarning("0.0.0.0", "a-real-password-1")).toBeNull();
    expect(defaultPasswordWarning("192.168.1.20", "a-real-password-1")).toBeNull();
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      expect(defaultPasswordWarning(host, "admin")).toBeNull();
      expect(defaultPasswordWarning(host, "change-this-password")).toBeNull();
    }
  });
});
