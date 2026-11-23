import type { ApiFn } from "../../components/dialogs";
import { createMockChatLimitsApi } from "./chatLimitsMock";

/** `GET/PUT /api/settings/chat`: the effective session limit and where it comes from. */
export type ChatLimitsView = {
  maxConversations: number;
  default: number;
  min: number;
  max: number;
  count: number;
  source: "db" | "env" | "default";
  locked: boolean;
};

export type ChatLimitsApi = {
  get: () => Promise<ChatLimitsView>;
  save: (maxConversations: number | null) => Promise<ChatLimitsView>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isSource = (value: unknown): value is ChatLimitsView["source"] =>
  value === "db" || value === "env" || value === "default";

export const isChatLimitsView = (value: unknown): value is ChatLimitsView =>
  isRecord(value) &&
  isNumber(value.maxConversations) &&
  isNumber(value.default) &&
  isNumber(value.min) &&
  isNumber(value.max) &&
  isNumber(value.count) &&
  isSource(value.source) &&
  typeof value.locked === "boolean";

async function request(api: ApiFn, init: RequestInit): Promise<ChatLimitsView> {
  const response = await api("/api/settings/chat", init);
  const body: unknown = await response.json();
  if (!isChatLimitsView(body)) throw new Error("The server sent an unexpected response.");
  return body;
}

export function createChatLimitsApi(api: ApiFn): ChatLimitsApi {
  return {
    get: () => request(api, {}),
    save: (maxConversations) =>
      request(api, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConversations }),
      }),
  };
}

/** Application wiring: `?mock=chat-limits` swaps in the in-memory settings view. */
export function chatLimitsApi(api: ApiFn): ChatLimitsApi {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mock") === "chat-limits") {
      const count = Number(query.get("count"));
      const max = Number(query.get("max"));
      const source = query.get("source");
      return createChatLimitsApi(
        createMockChatLimitsApi({
          ...(query.get("locked") === "1" ? { locked: true } : {}),
          ...(Number.isFinite(count) && count > 0 ? { count } : {}),
          ...(Number.isFinite(max) && max >= 20 ? { maxConversations: max } : {}),
          ...(source === "db" || source === "env" ? { source } : {}),
        }),
      );
    }
  }
  return createChatLimitsApi(api);
}
