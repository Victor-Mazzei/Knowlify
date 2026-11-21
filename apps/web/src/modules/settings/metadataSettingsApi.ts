import type { ApiFn } from "../../components/dialogs";
import { parseApiError } from "../../services/api";
import { createMockMetadataApi, mockMetadataScenario } from "./metadataSettingsMock";
import type { MetadataSettingsSave, MetadataSettingsView } from "./metadataTypes";

export type MetadataSettingsApi = {
  get: () => Promise<MetadataSettingsView>;
  save: (body: MetadataSettingsSave) => Promise<MetadataSettingsView>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);

const isLookupSource = oneOf(["env", "user"] as const);
const isKeyState = oneOf(["ok", "unreadable", "none"] as const);
const isKeySource = oneOf(["env", "user", "none"] as const);
const isProvider = oneOf(["openlibrary", "googlebooks"] as const);

const isView = (value: unknown): value is MetadataSettingsView => {
  if (!isRecord(value) || !isRecord(value.googleBooks)) return false;
  return (
    typeof value.lookupEnabled === "boolean" &&
    isLookupSource(value.lookupSource) &&
    typeof value.googleBooks.hasKey === "boolean" &&
    isKeyState(value.googleBooks.keyState) &&
    isKeySource(value.googleBooks.source) &&
    typeof value.locked === "boolean" &&
    Array.isArray(value.providers) &&
    value.providers.every(isProvider)
  );
};

async function request<T>(
  api: ApiFn,
  path: string,
  init: RequestInit,
  guard: (value: unknown) => value is T,
): Promise<T> {
  const response = await api(path, init);
  if (!response.ok) throw await parseApiError(response);
  const body: unknown = await response.json();
  if (!guard(body)) throw new Error("The server sent an unexpected response.");
  return body;
}

export function createMetadataSettingsApi(api: ApiFn): MetadataSettingsApi {
  return {
    get: () => request(api, "/api/settings/metadata", {}, isView),
    save: (body) =>
      request(
        api,
        "/api/settings/metadata",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        isView,
      ),
  };
}

/**
 * Application wiring: `?mock=metadata` (plus `&scenario=saved|locked|...`)
 * swaps in the in-memory provider without touching `services/api`.
 */
export function metadataSettingsApi(api: ApiFn): MetadataSettingsApi {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mock") === "metadata") {
      return createMetadataSettingsApi(
        createMockMetadataApi({ scenario: mockMetadataScenario(query.get("scenario")) }),
      );
    }
  }
  return createMetadataSettingsApi(api);
}
