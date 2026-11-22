import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Single place that reads the app version: the web package first, then the root
 * package (workspaces are released in lockstep), and a dev marker as last resort.
 */
function readAppVersion(): string {
  for (const file of ["./package.json", "../../package.json"]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        typeof parsed.version === "string" &&
        parsed.version
      ) {
        return parsed.version;
      }
    } catch {
      // Missing or unreadable file: try the next candidate.
    }
  }
  return "0.0.0-dev";
}

const require = createRequire(import.meta.url);
const PDFJS_WASM_DIR = join(dirname(require.resolve("pdfjs-dist/package.json")), "wasm");
const PDFJS_WASM_PREFIX = "pdfjs/wasm";
const PDFJS_WASM_FILES = readdirSync(PDFJS_WASM_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * pdf.js 6 requests its image codecs by filename at runtime (`openjpeg.wasm`,
 * `jbig2.wasm`, `qcms_bg.wasm`) and Vite cannot fingerprint files it never
 * imports. Serve the package directory under a stable path in dev and emit the
 * same files in the build, so `usePdfReader` can pass a durable `wasmUrl`.
 */
function pdfjsWasmAssets(): Plugin {
  return {
    name: "knowlify-pdfjs-wasm",
    configureServer(server) {
      const base = server.config.base.replace(/\/$/, "");
      const prefix = `${base}/${PDFJS_WASM_PREFIX}/`;
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0] ?? "";
        if (!pathname.startsWith(prefix)) {
          next();
          return;
        }
        let name: string;
        try {
          name = decodeURIComponent(pathname.slice(prefix.length));
        } catch {
          next();
          return;
        }
        if (!PDFJS_WASM_FILES.includes(name)) {
          next();
          return;
        }
        response.setHeader("Content-Type", CONTENT_TYPES[extname(name)] ?? "application/octet-stream");
        response.end(readFileSync(join(PDFJS_WASM_DIR, name)));
      });
    },
    generateBundle() {
      for (const name of PDFJS_WASM_FILES) {
        this.emitFile({
          type: "asset",
          fileName: `${PDFJS_WASM_PREFIX}/${name}`,
          source: readFileSync(join(PDFJS_WASM_DIR, name)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsWasmAssets()],
  define: { __APP_VERSION__: JSON.stringify(readAppVersion()) },
  server: {
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
