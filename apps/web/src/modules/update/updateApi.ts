import type { ApiFn } from "../../components/dialogs";
import { ApiError, parseApiError } from "../../services/api";
import { createMockUpdateApi, mockUpdateScenario } from "./updateMock";
import type { UpdateInfo, UpdateSettings, UpdateSettingSource } from "./updateTypes";

export type UpdateApi = {
  /** Current notice; null when this server predates `/api/update` (404) or sent an unexpected shape. */
  get: () => Promise<UpdateInfo | null>;
  /** Explicit "Check now"; null when the route is absent or the response is unusable. */
  check: () => Promise<UpdateInfo | null>;
  getSettings: () => Promise<UpdateSettings | null>;
  setEnabled: (enabled: boolean) => Promise<UpdateSettings>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isReleaseInfo = (value: unknown): boolean =>
  isRecord(value) && isNonEmptyString(value.version) && isNonEmptyString(value.url);

export function isUpdateInfo(value: unknown): value is UpdateInfo {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    typeof value.locked === "boolean" &&
    typeof value.canManage === "boolean" &&
    isNonEmptyString(value.current) &&
    (value.latest === null || isReleaseInfo(value.latest)) &&
    typeof value.available === "boolean" &&
    isNullableString(value.checkedAt)
  );
}

const SETTING_SOURCES: readonly UpdateSettingSource[] = ["default", "env", "db"];

const isUpdateSettings = (value: unknown): value is UpdateSettings =>
  isRecord(value) &&
  typeof value.enabled === "boolean" &&
  typeof value.locked === "boolean" &&
  typeof value.source === "string" &&
  (SETTING_SOURCES as readonly string[]).includes(value.source);

async function readBody<T>(
  api: ApiFn,
  path: string,
  init: RequestInit,
  guard: (body: unknown) => boolean,
): Promise<T | null> {
  let response: Response;
  try {
    response = await api(path, { cache: "no-store", ...init });
  } catch (reason) {
    // `services/api` throws for non-2xx; an old server is the only absence here.
    if (reason instanceof ApiError && reason.status === 404) return null;
    throw reason;
  }
  if (response.status === 404) return null;
  if (!response.ok) throw await parseApiError(response);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return guard(body) ? (body as T) : null;
}

export function createUpdateApi(api: ApiFn): UpdateApi {
  return {
    get: () => readBody<UpdateInfo>(api, "/api/update", { method: "GET" }, isUpdateInfo),

    check: () => readBody<UpdateInfo>(api, "/api/update/check", { method: "POST" }, isUpdateInfo),

    getSettings: () =>
      readBody<UpdateSettings>(api, "/api/settings/update", { method: "GET" }, isUpdateSettings),

    setEnabled: async (enabled) => {
      const response = await api("/api/settings/update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw await parseApiError(response);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("The server sent an unexpected response.");
      }
      if (!isUpdateSettings(body)) throw new Error("The server sent an unexpected response.");
      return body;
    },
  };
}

/** The dev mock is shared so the banner and the card see the same scenario state. */
let devMock: { search: string; api: ApiFn } | null = null;

function sharedDevMock(): ApiFn {
  const search = window.location.search;
  if (!devMock || devMock.search !== search) {
    const scenario = mockUpdateScenario(new URLSearchParams(search).get("scenario"));
    devMock = { search, api: createMockUpdateApi({ scenario }) };
  }
  return devMock.api;
}

/**
 * Application wiring: `?mock=update` (plus optional
 * `&scenario=available|disabled|unchecked|uptodate|locked|readonly|missing`)
 * swaps in the in-memory route for design work.
 */
export function updateApi(api: ApiFn): UpdateApi {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mock") === "update") return createUpdateApi(sharedDevMock());
  }
  return createUpdateApi(api);
}
