import { ValidationError } from "../errors.js";

/** Namespace of a personal access token; the prefix makes leaks easy to identify. */
export const MCP_TOKEN_PREFIX = "knw_mcp_";
/** 256 bits of entropy encoded as base64url: 32 bytes always take 43 characters. */
export const MCP_TOKEN_SECRET_LENGTH = 43;
/** Characters of the secret shown in the UI and in logs (48 bits, not reversible). */
export const MCP_TOKEN_PREFIX_SECRET_CHARS = 8;
export const MCP_TOKEN_NAME_MAX = 60;

export const MCP_SCOPES = ["read", "write_notes"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_TOKEN_LIMITS = {
  maxActive: 20,
  /** `last_used_at` is written at most once per minute per token. */
  lastUsedThrottleMs: 60_000,
} as const;

export interface McpToken {
  id: string;
  name: string;
  /** `knw_mcp_` plus the first 8 secret characters. */
  prefix: string;
  /** SHA-256 of the whole token in hex. The clear token is never persisted. */
  tokenHash: string;
  scope: McpScope;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const TOKEN_FORMAT = new RegExp(`^${MCP_TOKEN_PREFIX}[A-Za-z0-9_-]{${MCP_TOKEN_SECRET_LENGTH}}$`, "u");

/** Rejects empty names and control characters instead of silently rewriting the label. */
export function assertTokenName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Token name must be a string");
  const name = value.trim();
  if ([...name].length === 0 || [...name].length > MCP_TOKEN_NAME_MAX) {
    throw new ValidationError(`Token name must have 1 to ${MCP_TOKEN_NAME_MAX} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) throw new ValidationError("Token name cannot contain control characters");
  return name;
}

export function assertTokenScope(value: unknown): McpScope {
  if (typeof value !== "string" || !MCP_SCOPES.includes(value as McpScope)) {
    throw new ValidationError(`scope must be one of: ${MCP_SCOPES.join(", ")}`);
  }
  return value as McpScope;
}

export const isMcpTokenFormatted = (token: string): boolean => TOKEN_FORMAT.test(token);

/** Visible identification prefix; eight secret characters are far too few to brute-force. */
export const mcpTokenPrefix = (token: string): string =>
  token.slice(0, MCP_TOKEN_PREFIX.length + MCP_TOKEN_PREFIX_SECRET_CHARS);
