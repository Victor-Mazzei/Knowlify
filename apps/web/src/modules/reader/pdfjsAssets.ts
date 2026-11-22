/** Directory where the Vite plugin publishes the pdf.js 6 wasm codecs. */
const PDFJS_WASM_PATH = "pdfjs/wasm/";

/**
 * pdf.js 6 decodes JPEG 2000, JBIG2 and ICC profiles with wasm modules that it
 * fetches at runtime, so it needs an absolute URL ending in a slash. Vite
 * serves the `pdfjs-dist/wasm` directory at this path in dev and emits it in
 * the production build (see `vite.config.ts`).
 */
export function pdfjsWasmUrl(baseUrl: string = document.baseURI): string {
  return new URL(`${import.meta.env.BASE_URL}${PDFJS_WASM_PATH}`, baseUrl).href;
}
