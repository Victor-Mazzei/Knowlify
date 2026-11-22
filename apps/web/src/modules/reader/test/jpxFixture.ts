import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const PDFJS_WASM_DIR = join(
  dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
  "wasm",
);

const FIXTURE = new URL("./bug_jpx.pdf", import.meta.url);

export type DecodedImage = { width: number; height: number; data: Uint8ClampedArray };

function isDecodedImage(value: unknown): value is DecodedImage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.width === "number" &&
    typeof candidate.height === "number" &&
    Object.prototype.toString.call(candidate.data) === "[object Uint8ClampedArray]"
  );
}

/**
 * Reads the JPX image that page 1 paints. The fixture is pdf.js' Apache-2.0
 * `test/pdfs/bug_jpx.pdf`: without `wasmUrl`, OpenJPEG cannot start and the
 * worker leaves the image unresolved, so the page renders without its cover.
 */
export async function decodeCover(wasmUrl?: string, verbosity = 0): Promise<DecodedImage | undefined> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(FIXTURE));
  const loading = getDocument({ data, ...(wasmUrl ? { wasmUrl } : {}), verbosity });
  try {
    const pdf = await loading.promise;
    const page = await pdf.getPage(1);
    await page.getOperatorList();
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const image: unknown = page.objs.get("img_p0_1");
        if (isDecodedImage(image)) return image;
      } catch {
        // The worker resolves the image shortly after the operator list.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  } finally {
    await loading.destroy();
  }
}
