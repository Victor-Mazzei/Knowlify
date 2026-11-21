import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import {
  MCP_NAME_MAX,
  MCP_TOKEN_LIMIT,
  type McpCreatedToken,
  type McpScope,
  type McpToken,
  type McpTokensView,
} from "./mcpTypes";

export const MOCK_MCP_SCENARIOS = ["empty", "populated", "disabled", "limit", "error"] as const;

export type MockMcpScenario = (typeof MOCK_MCP_SCENARIOS)[number];

type MockMcpOptions = { scenario?: MockMcpScenario };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fail = (status: number, message: string, code?: string): never => {
  throw new ApiError(status, message, code);
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

const day = (value: number) => new Date(2026, 0, value, 12).getTime();

/** The list never carries the secret, even in the mock. */
const publicToken = (token: McpToken): McpToken => ({
  id: token.id,
  name: token.name,
  prefix: token.prefix,
  scope: token.scope,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
});

const initialTokens = (scenario: MockMcpScenario): McpToken[] => {
  if (scenario === "populated") {
    return [
      {
        id: "tok_claude",
        name: "Claude Code",
        prefix: "knw_mcp_4f2a9c1e",
        scope: "write_notes",
        createdAt: day(12),
        lastUsedAt: day(19),
      },
      {
        id: "tok_research",
        name: "Research notes",
        prefix: "knw_mcp_9b7d3e2a",
        scope: "read",
        createdAt: day(8),
        lastUsedAt: null,
      },
    ];
  }
  if (scenario === "limit") {
    return Array.from({ length: MCP_TOKEN_LIMIT }, (_, index) => ({
      id: `tok_${index + 1}`,
      name: `Token ${index + 1}`,
      prefix: `knw_mcp_mock${String(index).padStart(4, "0")}`,
      scope: index % 3 === 0 ? ("write_notes" as const) : ("read" as const),
      createdAt: day(1 + (index % 20)),
      lastUsedAt: null,
    }));
  }
  return [];
};

/** In-memory stand-in for `/api/mcp/tokens`, used by tests and `?mock=mcp` in dev. */
export function createMockMcpApi(options: MockMcpOptions = {}): ApiFn {
  const scenario = options.scenario ?? "populated";
  const enabled = scenario !== "disabled";
  const tokens = initialTokens(scenario);
  let issued = 0;

  const issue = (name: string, scope: McpScope): McpCreatedToken => {
    issued += 1;
    const secret = `${issued.toString(36).padStart(4, "0")}${"mock".repeat(10)}`.slice(0, 43);
    const token = `knw_mcp_${secret}`;
    const created: McpCreatedToken = {
      id: `tok_new_${issued}`,
      name,
      prefix: token.slice(0, "knw_mcp_".length + 8),
      scope,
      createdAt: Date.now(),
      lastUsedAt: null,
      token,
    };
    tokens.unshift(created);
    return created;
  };

  return async (path, init = {}) => {
    const url = new URL(path, "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    const body = readBody(init);

    if (url.pathname === "/api/mcp/tokens" && method === "GET") {
      if (scenario === "error") fail(500, "The server could not load MCP tokens.");
      if (!enabled) fail(404, "MCP access is disabled by the server operator.", "mcp_disabled");
      const view: McpTokensView = { enabled: true, path: "/mcp", items: tokens.map(publicToken) };
      return json(200, view);
    }

    if (url.pathname === "/api/mcp/tokens" && method === "POST") {
      if (!enabled) fail(404, "MCP access is disabled by the server operator.", "mcp_disabled");
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const scope: McpScope =
        body?.scope === "read"
          ? "read"
          : body?.scope === "write_notes"
            ? "write_notes"
            : fail(400, "Unknown token scope.");
      if (!name || name.length > MCP_NAME_MAX) {
        fail(400, `Token names must be between 1 and ${MCP_NAME_MAX} characters.`);
      }
      if (tokens.length >= MCP_TOKEN_LIMIT) {
        fail(409, "You can have up to 20 active tokens.", "token_limit_reached");
      }
      const created = issue(name, scope);
      return json(201, created);
    }

    if (url.pathname.startsWith("/api/mcp/tokens/") && method === "DELETE") {
      if (!enabled) fail(404, "MCP access is disabled by the server operator.", "mcp_disabled");
      const id = decodeURIComponent(url.pathname.slice("/api/mcp/tokens/".length));
      const index = tokens.findIndex((token) => token.id === id);
      if (index < 0) fail(404, "Token not found.");
      tokens.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    return fail(404, "Mock MCP route not found.");
  };
}

export function mockMcpScenario(value: string | null): MockMcpScenario {
  return (MOCK_MCP_SCENARIOS as readonly string[]).includes(value ?? "")
    ? (value as MockMcpScenario)
    : "populated";
}
