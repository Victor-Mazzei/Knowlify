// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { decodeCover } from "./test/jpxFixture";

describe("pdf.js 6 without wasm assets", () => {
  it("cannot decode a JPEG 2000 cover and leaves it unresolved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await decodeCover(undefined, 1)).toBeUndefined();
      expect(warn.mock.calls.flat().join(" ")).toContain("OpenJPEG failed to initialize");
    } finally {
      warn.mockRestore();
    }
  });
});
