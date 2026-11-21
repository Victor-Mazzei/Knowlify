/**
 * HTTP contract types for the MCP access card (`/api/mcp/tokens`).
 * Mirrors docs/planner/2026-11-20-notes-groups-global-tutor-mcp.md.
 * Keep this module free of server imports and runtime logic.
 */

export type McpScope = "read" | "write_notes";

/** Active token as returned by `GET /api/mcp/tokens`; the secret is never included. */
export type McpToken = {
  id: string;
  name: string;
  prefix: string;
  scope: McpScope;
  createdAt: number;
  lastUsedAt: number | null;
};

/** `POST /api/mcp/tokens` response: the only time the plain-text token is returned. */
export type McpCreatedToken = McpToken & { token: string };

export type McpTokensView = {
  enabled: boolean;
  path: string;
  items: McpToken[];
};

export type McpCreateRequest = {
  name: string;
  scope: McpScope;
};

export const MCP_NAME_MAX = 60;
export const MCP_TOKEN_LIMIT = 20;
export const MCP_DEFAULT_PATH = "/mcp";
