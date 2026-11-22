import { describe, expect, it } from "vitest";
import { pdfjsWasmUrl } from "./pdfjsAssets";

describe("pdfjsWasmUrl", () => {
  it("returns an absolute directory URL that pdf.js can fetch from", () => {
    expect(pdfjsWasmUrl("http://localhost:5174/book/1")).toBe("http://localhost:5174/pdfjs/wasm/");
  });

  it("keeps the trailing slash required by pdf.js factory URLs", () => {
    expect(pdfjsWasmUrl()).toMatch(/\/pdfjs\/wasm\/$/);
  });
});
