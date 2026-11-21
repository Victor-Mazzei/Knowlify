import type { McpToken } from "../domain/access/McpToken.js";

/**
 * Access tokens for the MCP endpoint (ADR-4). Only active rows are listed; revoked rows
 * stay in the table as an audit trail and are never returned to the client.
 */
export interface McpTokenRepository {
  listActive(): McpToken[];
  get(id: string): McpToken | undefined;
  /** Active rows with this visible prefix; the partial index in v10 covers the lookup. */
  byPrefix(prefix: string): McpToken[];
  save(token: McpToken): void;
  countActive(): number;
  /** Marks a token revoked; false when it was already revoked or does not exist. */
  revoke(id: string, at: number): boolean;
  /** Updates `last_used_at` only while the token is still active. */
  markUsed(id: string, at: number): void;
}

/** Generation and hashing of the opaque bearer token. */
export interface TokenCodec {
  generate(): { token: string; prefix: string; hash: string };
  hash(token: string): string;
  prefix(token: string): string;
}
