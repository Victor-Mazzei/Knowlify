import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { validateMetadataKey } from "./metadataForm";
import type { MetadataSettingsView } from "./metadataTypes";

export const MOCK_METADATA_SCENARIOS = [
  "default",
  "saved",
  "env-key",
  "locked",
  "unreadable",
  "unavailable",
] as const;

export type MockMetadataScenario = (typeof MOCK_METADATA_SCENARIOS)[number];

type MockMetadataOptions = { scenario?: MockMetadataScenario };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fail = (status: number, message: string): never => {
  throw new ApiError(status, message);
};

const readBody = (init: RequestInit | undefined): Record<string, unknown> | null => {
  if (typeof init?.body !== "string") return null;
  try {
    const value: unknown = JSON.parse(init.body);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

export function initialMetadataView(scenario: MockMetadataScenario = "default"): MetadataSettingsView {
  const base: MetadataSettingsView = {
    lookupEnabled: true,
    lookupSource: "env",
    googleBooks: { hasKey: false, keyState: "none", source: "none" },
    locked: false,
    providers: ["openlibrary", "googlebooks"],
  };
  if (scenario === "saved" || scenario === "unreadable") {
    return {
      ...base,
      lookupSource: "user",
      googleBooks: { hasKey: true, keyState: scenario === "unreadable" ? "unreadable" : "ok", source: "user" },
    };
  }
  if (scenario === "env-key" || scenario === "locked") {
    return {
      ...base,
      locked: scenario === "locked",
      googleBooks: { hasKey: true, keyState: "ok", source: "env" },
    };
  }
  return base;
}

/** In-memory stand-in for `/api/settings/metadata`, used by tests and `?mock=metadata`. */
export function createMockMetadataApi(options: MockMetadataOptions = {}): ApiFn {
  const scenario = options.scenario ?? "default";
  let view = initialMetadataView(scenario);
  const envHasKey = view.googleBooks.source === "env" && view.googleBooks.hasKey;

  return async (path, init = {}) => {
    const url = new URL(path, "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    if (url.pathname !== "/api/settings/metadata") fail(404, "Mock metadata route not found.");
    if (method === "GET") {
      if (scenario === "unavailable") fail(404, "Not found.");
      return json(200, view);
    }
    if (method !== "PUT") fail(404, "Mock metadata route not found.");
    if (view.locked) fail(403, "Metadata settings are locked by the server operator.");

    const body = readBody(init);
    if (body && typeof body.lookupEnabled === "boolean") {
      view = { ...view, lookupEnabled: body.lookupEnabled, lookupSource: "user" };
    }
    if (body && "googleBooksKey" in body) {
      const key = body.googleBooksKey;
      if (key === null) {
        view = {
          ...view,
          googleBooks: envHasKey
            ? { hasKey: true, keyState: "ok", source: "env" }
            : { hasKey: false, keyState: "none", source: "none" },
        };
      } else if (typeof key === "string") {
        const problem = validateMetadataKey(key);
        if (problem) fail(400, problem);
        view = { ...view, googleBooks: { hasKey: true, keyState: "ok", source: "user" } };
      } else {
        fail(400, "The Google Books key must be a string or null.");
      }
    }
    return json(200, view);
  };
}

export function mockMetadataScenario(value: string | null): MockMetadataScenario {
  return (MOCK_METADATA_SCENARIOS as readonly string[]).includes(value ?? "")
    ? (value as MockMetadataScenario)
    : "default";
}
