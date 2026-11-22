import { timingSafeEqual } from "node:crypto";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import {
  MCP_TOKEN_LIMITS,
  assertTokenName,
  assertTokenScope,
  isMcpTokenFormatted,
  type McpScope,
  type McpToken,
} from "../domain/access/McpToken.js";
import type { McpTokenRepository, TokenCodec } from "../ports/access.js";
import type { Clock, IdGenerator } from "../ports/index.js";

export interface McpTokenView {
  id: string;
  name: string;
  prefix: string;
  scope: McpScope;
  createdAt: number;
  lastUsedAt: number | null;
}

/** What the transport needs from an authenticated token; the hash never leaves this layer. */
export interface McpPrincipal {
  tokenId: string;
  name: string;
  prefix: string;
  scope: McpScope;
}

export interface CreateMcpTokenInput {
  name: unknown;
  scope: unknown;
}

export interface CreatedMcpToken {
  /** The clear token. It is returned once, here, and never stored or logged. */
  token: string;
  view: McpTokenView;
}

const viewOf = (token: McpToken): McpTokenView => ({
  id: token.id,
  name: token.name,
  prefix: token.prefix,
  scope: token.scope,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
});

const sameHash = (stored: string, candidate: string): boolean => {
  const left = Buffer.from(stored, "utf8");
  const right = Buffer.from(candidate, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * MCP access tokens (ADR-4): creation, listing, revocation and authentication.
 * Authentication always reads the database, so a revocation takes effect on the next
 * request without a cache to invalidate.
 */
export class McpAccess {
  constructor(
    private readonly tokens: McpTokenRepository,
    private readonly codec: TokenCodec,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly limits: { maxActive: number; lastUsedThrottleMs: number } = {
      maxActive: MCP_TOKEN_LIMITS.maxActive,
      lastUsedThrottleMs: MCP_TOKEN_LIMITS.lastUsedThrottleMs,
    },
  ) {}

  create(input: CreateMcpTokenInput): CreatedMcpToken {
    const name = assertTokenName(input.name);
    const scope = assertTokenScope(input.scope);
    if (this.tokens.countActive() >= this.limits.maxActive) {
      throw new ConflictError(`At most ${this.limits.maxActive} active tokens are allowed`, "token_limit_reached");
    }
    const generated = this.codec.generate();
    const token: McpToken = {
      id: this.ids.next(),
      name,
      prefix: generated.prefix,
      tokenHash: generated.hash,
      scope,
      createdAt: this.clock.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.tokens.save(token);
    return { token: generated.token, view: viewOf(token) };
  }

  list(): McpTokenView[] {
    return this.tokens.listActive().map(viewOf);
  }

  /** Unknown ids are a 404; revoking an already revoked token is a no-op (idempotent). */
  revoke(id: string): void {
    const token = this.tokens.get(id);
    if (!token) throw new NotFoundError("Token not found");
    if (token.revokedAt !== null) return;
    this.tokens.revoke(id, this.clock.now());
  }

  /**
   * Returns the principal for a live token. Malformed, unknown and revoked tokens all
   * produce null; the HTTP layer answers the same generic 401 for every case.
   */
  authenticate(token: string): McpPrincipal | null {
    const active = this.active(token);
    if (!active) return null;
    const now = this.clock.now();
    if (active.lastUsedAt === null || now - active.lastUsedAt >= this.limits.lastUsedThrottleMs) {
      this.tokens.markUsed(active.id, now);
    }
    return { tokenId: active.id, name: active.name, prefix: active.prefix, scope: active.scope };
  }

  /**
   * Diagnosis only, after `authenticate` returned null. It reads revoked rows only on
   * this failure path, so a valid request keeps using the partial prefix index.
   */
  failureReason(token: string): "revoked" | "invalid" {
    if (!isMcpTokenFormatted(token)) return "invalid";
    const hash = this.codec.hash(token);
    const revoked = this.tokens.revokedByPrefix(this.codec.prefix(token))
      .some((row) => sameHash(row.tokenHash, hash));
    return revoked ? "revoked" : "invalid";
  }

  private active(token: string): McpToken | null {
    if (!isMcpTokenFormatted(token)) return null;
    const hash = this.codec.hash(token);
    return this.tokens.byPrefix(this.codec.prefix(token))
      .find((row) => sameHash(row.tokenHash, hash)) ?? null;
  }
}
