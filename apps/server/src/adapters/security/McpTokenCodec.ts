import { createHash, randomBytes } from "node:crypto";
import {
  MCP_TOKEN_PREFIX,
  MCP_TOKEN_SECRET_LENGTH,
  mcpTokenPrefix,
} from "../../domain/access/McpToken.js";
import type { TokenCodec } from "../../ports/access.js";

/** 256-bit random token; SHA-256 is enough because the secret is not user-chosen. */
export class McpTokenCodec implements TokenCodec {
  generate(): { token: string; prefix: string; hash: string } {
    const secret = randomBytes(32).toString("base64url");
    if (secret.length !== MCP_TOKEN_SECRET_LENGTH) throw new Error("Unexpected token encoding");
    const token = `${MCP_TOKEN_PREFIX}${secret}`;
    return { token, prefix: mcpTokenPrefix(token), hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  prefix(token: string): string {
    return mcpTokenPrefix(token);
  }
}
