import type { McpScope, McpToken } from "../../domain/access/McpToken.js";
import type { McpTokenRepository } from "../../ports/access.js";
import type { Db } from "./db.js";

interface McpTokenRow {
  id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  scope: McpScope;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const toToken = (row: McpTokenRow): McpToken => ({
  id: row.id,
  name: row.name,
  prefix: row.token_prefix,
  tokenHash: row.token_hash,
  scope: row.scope,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
});

/** `mcp_tokens` (migration v10). Only the hash is stored; the clear token never reaches SQL. */
export class SqliteMcpTokenRepository implements McpTokenRepository {
  constructor(private readonly db: Db) {}

  listActive(): McpToken[] {
    const rows = this.db.prepare(
      "SELECT * FROM mcp_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC, id DESC",
    ).all() as McpTokenRow[];
    return rows.map(toToken);
  }

  get(id: string): McpToken | undefined {
    const row = this.db.prepare("SELECT * FROM mcp_tokens WHERE id = ?").get(id) as McpTokenRow | undefined;
    return row && toToken(row);
  }

  byPrefix(prefix: string): McpToken[] {
    const rows = this.db.prepare(
      "SELECT * FROM mcp_tokens WHERE token_prefix = ? AND revoked_at IS NULL",
    ).all(prefix) as McpTokenRow[];
    return rows.map(toToken);
  }

  save(token: McpToken): void {
    this.db.prepare(`INSERT INTO mcp_tokens
      (id, name, token_prefix, token_hash, scope, created_at, last_used_at, revoked_at)
      VALUES (@id, @name, @prefix, @tokenHash, @scope, @createdAt, @lastUsedAt, @revokedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        token_prefix = excluded.token_prefix,
        token_hash = excluded.token_hash,
        scope = excluded.scope,
        last_used_at = excluded.last_used_at,
        revoked_at = excluded.revoked_at`).run(token);
  }

  countActive(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM mcp_tokens WHERE revoked_at IS NULL").get() as { n: number }).n;
  }

  revoke(id: string, at: number): boolean {
    return this.db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(at, id).changes > 0;
  }

  markUsed(id: string, at: number): void {
    this.db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
  }
}
