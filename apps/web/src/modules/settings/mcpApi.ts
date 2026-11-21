import type { ApiFn } from "../../components/dialogs";
import { ApiError, parseApiError } from "../../services/api";
import { createMockMcpApi, mockMcpScenario } from "./mcpMock";
import {
  MCP_DEFAULT_PATH,
  type McpCreateRequest,
  type McpCreatedToken,
  type McpScope,
  type McpToken,
  type McpTokensView,
} from "./mcpTypes";

export type McpApi = {
  get: () => Promise<McpTokensView>;
  create: (body: McpCreateRequest) => Promise<McpCreatedToken>;
  revoke: (id: string) => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isScope = (value: unknown): value is McpScope => value === "read" || value === "write_notes";

const isToken = (value: unknown): value is McpToken =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  typeof value.prefix === "string" &&
  isScope(value.scope) &&
  isNumber(value.createdAt) &&
  (value.lastUsedAt === null || isNumber(value.lastUsedAt));

const isView = (value: unknown): value is McpTokensView =>
  isRecord(value) &&
  typeof value.enabled === "boolean" &&
  typeof value.path === "string" &&
  Array.isArray(value.items) &&
  value.items.every(isToken);

const isCreatedToken = (value: unknown): value is McpCreatedToken =>
  isRecord(value) && typeof value.token === "string" && isToken(value);

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

export function createMcpApi(api: ApiFn): McpApi {
  return {
    get: () => request(api, "/api/mcp/tokens", {}, isView),
    create: (body) =>
      request(
        api,
        "/api/mcp/tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        isCreatedToken,
      ),
    revoke: async (id) => {
      const response = await api(`/api/mcp/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw await parseApiError(response);
    },
  };
}

/** `enabled:false` is served by servers that keep the token route when MCP is off. */
export const isMcpDisabled = (reason: unknown) =>
  reason instanceof ApiError && reason.status === 404 && reason.code === "mcp_disabled";

/** A 404 without `mcp_disabled` means the server predates the MCP contract; hide the card. */
export const isMcpUnavailable = (reason: unknown) =>
  reason instanceof ApiError && reason.status === 404 && reason.code !== "mcp_disabled";

/** Absolute `/mcp` URL using the same base the API layer talks to. */
export function endpointUrl(path: string = MCP_DEFAULT_PATH): string {
  const base = (window.__KNOWLIFY__?.apiBaseUrl ?? window.location.origin).replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Application wiring: `?mock=mcp` (plus optional `&scenario=empty|disabled|limit|error`)
 * swaps in the in-memory provider tree without touching `services/api`.
 */
export function mcpApi(api: ApiFn): McpApi {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mock") === "mcp") {
      return createMcpApi(createMockMcpApi({ scenario: mockMcpScenario(query.get("scenario")) }));
    }
  }
  return createMcpApi(api);
}
