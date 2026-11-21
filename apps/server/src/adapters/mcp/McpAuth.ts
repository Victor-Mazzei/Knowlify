import type { AuthInfo } from "@modelcontextprotocol/server";
import type { McpAccess, McpPrincipal } from "../../use-cases/McpAccess.js";
import { RateWindow } from "./RateWindow.js";

export type McpAuthResult =
  | { ok: true; principal: McpPrincipal; token: string }
  | { ok: false; status: 401 | 429; retryAfterSec?: number };

export interface McpAuthOptions {
  /** Failed attempts per IP per minute; valid tokens are never throttled by this window. */
  failurePerMin: number;
}

const BEARER = /^Bearer ([^\s]+)$/iu;

/**
 * Bearer verification in front of the SDK. The SDK treats `authInfo` as pass-through,
 * so this class is the only place that decides whether a request may reach a handler.
 */
export class McpAuth {
  private readonly failures: RateWindow;

  constructor(
    private readonly access: McpAccess,
    options: McpAuthOptions,
  ) {
    this.failures = new RateWindow(options.failurePerMin);
  }

  authenticate(header: string | undefined, ip: string): McpAuthResult {
    const match = header === undefined ? null : BEARER.exec(header.trim());
    if (!match) return this.fail(ip);
    const token = match[1]!;
    const principal = this.access.authenticate(token);
    if (!principal) return this.fail(ip);
    return { ok: true, principal, token };
  }

  private fail(ip: string): Extract<McpAuthResult, { ok: false }> {
    const rate = this.failures.hit(ip);
    return rate.allowed ? { ok: false, status: 401 } : { ok: false, status: 429, retryAfterSec: rate.retryAfterSec };
  }
}

/** Shape consumed by the SDK factories and tool handlers; never includes the token hash. */
export const authInfoFor = (principal: McpPrincipal, token: string): AuthInfo => ({
  token,
  clientId: principal.tokenId,
  scopes: [principal.scope],
  extra: { tokenName: principal.name, prefix: principal.prefix },
});

export const tokenNameOf = (authInfo: AuthInfo | undefined): string => {
  const value = authInfo?.extra?.tokenName;
  return typeof value === "string" && value.length > 0 ? value : "MCP token";
};

/** Defense in depth: the write handler is only built for write tokens, and tools re-check. */
export const hasWriteScope = (authInfo: AuthInfo | undefined): boolean =>
  authInfo?.scopes.includes("write_notes") === true;
