// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * pdf.js 6 calls `Map.prototype.getOrInsert*` and `WeakMap.prototype.getOrInsert*`
 * (the ES Upsert proposal). Older WebKit, WebView2 and WebKitGTK builds lack
 * them, which broke PDF rendering in the packaged desktop app. The reader uses
 * the legacy pdf.js build because it installs those polyfills.
 *
 * Run before importing pdf.js: once the legacy module has run, the polyfills are
 * already on the prototype and deleting them would prove nothing.
 */
const upsertMethods = ["getOrInsert", "getOrInsertComputed"] as const;
const prototypes = [Map.prototype, WeakMap.prototype];
const saved = prototypes.map((proto) =>
  upsertMethods.map((name) => Object.getOwnPropertyDescriptor(proto, name)),
);
for (const proto of prototypes) {
  for (const name of upsertMethods) Reflect.deleteProperty(proto, name);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

afterAll(() => {
  prototypes.forEach((proto, index) => {
    saved[index].forEach((descriptor, method) => {
      if (descriptor) Object.defineProperty(proto, upsertMethods[method], descriptor);
    });
  });
});

type NapiCanvas = {
  width: number;
  height: number;
  getContext: (kind: "2d") => CanvasRenderingContext2D;
};

/** Reads pixels so the test fails when a page renders blank instead of throwing. */
function countInk(context: CanvasRenderingContext2D, width: number, height: number) {
  const { data } = context.getImageData(0, 0, width, height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) ink += 1;
  }
  return ink;
}

describe("pdf.js 6 on engines without the ES Upsert methods", () => {
  it("brings the prototype methods back before pdf.js runs", () => {
    expect(typeof Reflect.get(Map.prototype, "getOrInsertComputed")).toBe("function");
    expect(typeof Reflect.get(Map.prototype, "getOrInsert")).toBe("function");
    expect(typeof Reflect.get(WeakMap.prototype, "getOrInsertComputed")).toBe("function");
    expect(typeof Reflect.get(WeakMap.prototype, "getOrInsert")).toBe("function");
  });

  it("opens and renders a page", async () => {
    const require = createRequire(import.meta.url);
    const { createCanvas } = require("@napi-rs/canvas") as {
      createCanvas: (width: number, height: number) => NapiCanvas;
    };
    const data = new Uint8Array(await readFile(new URL("./test/three-pages.pdf", import.meta.url)));
    const loading = pdfjs.getDocument({ data, verbosity: 0 });
    try {
      const pdf = await loading.promise;
      const page = await pdf.getPage(2);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;

      expect(pdf.numPages).toBe(3);
      expect(countInk(canvas.getContext("2d"), canvas.width, canvas.height)).toBeGreaterThan(1000);
    } finally {
      await loading.destroy();
    }
  });

  it(
    "installs the polyfills inside the worker realm too",
    async () => {
      const { Worker } = await import("node:worker_threads");
      const { pathToFileURL, fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      const require = createRequire(import.meta.url);
      const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
      const probe = join(dirname(fileURLToPath(import.meta.url)), "test", "upsertWorkerProbe.mjs");
      const result = await new Promise<Record<string, string>>((resolve, reject) => {
        const worker = new Worker(probe, {
          workerData: {
            workerModule: pathToFileURL(join(pdfjsRoot, "legacy/build/pdf.worker.mjs")).href,
          },
        });
        worker.once("message", (message: Record<string, string>) => {
          resolve(message);
          void worker.terminate();
        });
        worker.once("error", reject);
      });

      expect(result.before).toBe("undefined");
      expect(result.mapComputed).toBe("function");
      expect(result.mapInsert).toBe("function");
      expect(result.weakComputed).toBe("function");
      expect(result.weakInsert).toBe("function");
    },
    30_000,
  );
});
