import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";

export type MockChatLimitsOptions = {
  maxConversations?: number;
  count?: number;
  source?: "db" | "env" | "default";
  locked?: boolean;
  default?: number;
  min?: number;
  max?: number;
  /** Simulates the network guard: reads still work, writes only work on the computer. */
  localOnly?: boolean;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** In-memory stand-in for `GET/PUT /api/settings/chat`, used by tests and `?mock=chat-limits`. */
export function createMockChatLimitsApi(options: MockChatLimitsOptions = {}): ApiFn {
  const min = options.min ?? 20;
  const max = options.max ?? 5000;
  const fallback = options.default ?? 200;
  const locked = options.locked ?? false;
  let maxConversations = options.maxConversations ?? fallback;
  let source = options.source ?? "default";
  const count = options.count ?? 0;

  const view = () => ({
    maxConversations,
    default: fallback,
    min,
    max,
    count,
    source,
    locked,
  });

  return async (path, init = {}) => {
    if (path !== "/api/settings/chat") {
      throw new ApiError(404, "Mock chat limits route not found.");
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET") return json(200, view());
    if (method !== "PUT") throw new ApiError(405, "Method not allowed.");
    if (options.localOnly) throw new ApiError(403, "Forbidden", "local_only");
    if (locked) throw new ApiError(403, "The server manages this setting.", "llm_locked");
    let body: unknown;
    try {
      body = JSON.parse(typeof init.body === "string" ? init.body : "");
    } catch {
      throw new ApiError(400, `Enter a whole number from ${min} to ${max}.`, "invalid_value");
    }
    if (typeof body !== "object" || body === null || !("maxConversations" in body)) {
      throw new ApiError(400, `Enter a whole number from ${min} to ${max}.`, "invalid_value");
    }
    const value = body.maxConversations;
    if (value === null) {
      maxConversations = fallback;
      source = "default";
      return json(200, view());
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new ApiError(400, `Enter a whole number from ${min} to ${max}.`, "invalid_value");
    }
    maxConversations = value;
    source = "db";
    return json(200, view());
  };
}

export const mockChatLimitsApi: ApiFn = createMockChatLimitsApi();
