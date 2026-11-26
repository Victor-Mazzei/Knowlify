import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import type { ReleaseInfo, UpdateInfo, UpdateSettings } from "./updateTypes";

export type MockUpdateScenario =
  | "available"
  | "cooldown"
  | "disabled"
  | "unchecked"
  | "uptodate"
  | "locked"
  | "readonly"
  | "missing";

/** `?mock=update&scenario=…`; unknown or absent values fall back to a new release. */
export function mockUpdateScenario(value: string | null): MockUpdateScenario {
  switch (value) {
    case "cooldown":
    case "disabled":
    case "unchecked":
    case "uptodate":
    case "locked":
    case "readonly":
    case "missing":
      return value;
    default:
      return "available";
  }
}

const CURRENT = "2.4.0";
const LATEST: ReleaseInfo = {
  version: "2.5.0",
  url: "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const failure = (status: number, code: string, message: string) => json({ message, code }, status);

/**
 * In-memory stand-in for the update routes, used by tests and `?mock=update`
 * in dev. It keeps the last answer and reacts to Check now and the switch so
 * the card can be reviewed without a server.
 */
export function createMockUpdateApi(options: { scenario?: MockUpdateScenario } = {}): ApiFn {
  const scenario = options.scenario ?? "available";
  let enabled = scenario !== "disabled";
  const locked = scenario === "locked";
  const canManage = scenario !== "readonly";
  let latest: ReleaseInfo | null =
    scenario === "available" || scenario === "cooldown" || scenario === "locked" || scenario === "readonly"
      ? LATEST
      : scenario === "uptodate"
        ? { version: CURRENT, url: "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.4.0" }
        : null;
  let available = latest !== null && latest.version !== CURRENT;
  // The cooldown scenario starts as if the page-load check had just finished,
  // so the first explicit click is served from cache.
  let checkedAt =
    scenario === "cooldown"
      ? new Date().toISOString()
      : latest
        ? "2026-11-25T12:00:00.000Z"
        : null;
  let lastForcedCheck: number | null = null;

  const info = (): UpdateInfo => ({
    enabled,
    locked,
    canManage,
    current: CURRENT,
    latest,
    available: enabled && available,
    checkedAt: enabled ? checkedAt : null,
  });

  const settings = (): UpdateSettings => ({
    enabled,
    locked,
    source: locked ? "env" : "db",
  });

  return async (path, init = {}) => {
    const pathname = new URL(path, "http://mock.local").pathname;
    if (scenario === "missing") throw new ApiError(404, "Request failed (404)");

    if (pathname === "/api/update" && (init.method ?? "GET") === "GET") return json(info());

    if (pathname === "/api/update/check" && init.method === "POST") {
      if (!enabled) return json(info());
      const now = Date.now();
      const coolingDown =
        scenario === "cooldown" ||
        (lastForcedCheck !== null && now - lastForcedCheck < 60_000);
      if (coolingDown) return json(info());
      lastForcedCheck = now;
      latest = LATEST;
      available = true;
      checkedAt = new Date(now).toISOString();
      return json(info());
    }

    if (pathname === "/api/settings/update") {
      if ((init.method ?? "GET") === "GET") return json(settings());
      if (init.method === "PUT") {
        if (locked) {
          return failure(403, "update_locked", "These settings are managed by the server administrator.");
        }
        if (!canManage) return failure(403, "local_only", "Forbidden");
        let body: unknown;
        try {
          body = JSON.parse(String(init.body ?? ""));
        } catch {
          body = null;
        }
        if (!isRecord(body) || typeof body.enabled !== "boolean") {
          return failure(400, "invalid_body", "Invalid request body.");
        }
        enabled = body.enabled;
        if (!enabled) {
          latest = null;
          available = false;
          checkedAt = null;
        }
        return json(settings());
      }
    }

    throw new ApiError(404, "Mock update route not found.");
  };
}
