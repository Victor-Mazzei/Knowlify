import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import type { AboutInfo } from "./aboutTypes";

export type MockAboutScenario =
  | "release"
  | "dev"
  | "missing"
  | "error"
  | "no-source"
  | "unsafe-source";

const SOURCE_URL = "https://github.com/knowlify/knowlify";

const RELEASE_INFO: AboutInfo = {
  version: "1.2.3",
  commit: "a3e1c7f",
  builtAt: "2026-11-07T12:00:00Z",
  node: "22.11.0",
  sourceUrl: SOURCE_URL,
};

const DEV_INFO: AboutInfo = {
  version: "0.0.0-dev",
  commit: null,
  builtAt: null,
  node: "24.22.2",
  sourceUrl: SOURCE_URL,
};

const json = (body: AboutInfo) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/**
 * In-memory stand-in for `/api/about`, used by tests and `?mock=about` in dev.
 * "missing" reproduces a server that predates the route; "no-source" and
 * "unsafe-source" cover the optional repository link.
 */
export function createMockAboutApi(options: { scenario?: MockAboutScenario } = {}): ApiFn {
  const scenario = options.scenario ?? "release";
  return async (path) => {
    if (new URL(path, "http://mock.local").pathname !== "/api/about") {
      throw new ApiError(404, "Mock about route not found.");
    }
    if (scenario === "missing") throw new ApiError(404, "Request failed (404)");
    if (scenario === "error") throw new ApiError(500, "The server could not read its version.");
    if (scenario === "no-source") return json({ ...RELEASE_INFO, sourceUrl: null });
    if (scenario === "unsafe-source") return json({ ...RELEASE_INFO, sourceUrl: "javascript:alert(1)" });
    return json(scenario === "dev" ? DEV_INFO : RELEASE_INFO);
  };
}
