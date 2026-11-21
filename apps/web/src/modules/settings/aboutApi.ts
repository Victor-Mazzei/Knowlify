import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { createMockAboutApi } from "./aboutMock";
import type { AboutInfo } from "./aboutTypes";

export type AboutApi = {
  get: () => Promise<AboutInfo>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isAboutInfo = (value: unknown): value is AboutInfo =>
  isRecord(value) &&
  typeof value.version === "string" &&
  value.version.length > 0 &&
  isNullableString(value.commit) &&
  isNullableString(value.builtAt) &&
  typeof value.node === "string" &&
  (value.sourceUrl === undefined || isNullableString(value.sourceUrl));

export function createAboutApi(api: ApiFn): AboutApi {
  return {
    get: async () => {
      const response = await api("/api/about", { cache: "no-store" });
      if (!response.ok) throw new ApiError(response.status, `Could not read the app version (${response.status}).`);
      const body: unknown = await response.json();
      if (!isAboutInfo(body)) throw new Error("The server sent an unexpected response.");
      return body;
    },
  };
}

/** Application wiring: `?mock=about` swaps in the in-memory route for design work. */
export function aboutApi(api: ApiFn): AboutApi {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mock") === "about") return createAboutApi(createMockAboutApi());
  }
  return createAboutApi(api);
}
