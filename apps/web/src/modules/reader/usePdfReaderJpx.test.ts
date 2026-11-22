// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeCover, PDFJS_WASM_DIR } from "./test/jpxFixture";

describe("pdf.js 6 JPEG 2000 support", () => {
  it("decodes the JPX cover when wasmUrl points at the codec directory", async () => {
    const image = await decodeCover(`${PDFJS_WASM_DIR}/`);
    if (!image) throw new Error("The JPX image did not decode");
    expect(image.width).toBe(128);
    expect(image.height).toBe(64);
    expect(image.data).toHaveLength(128 * 64 * 3);
  });
});
