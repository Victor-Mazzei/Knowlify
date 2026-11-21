import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
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

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(readAppVersion()) },
  server: {
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
