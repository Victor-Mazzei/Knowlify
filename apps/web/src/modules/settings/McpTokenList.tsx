import { useId } from "react";
import type { McpToken } from "./mcpTypes";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

const timestamp = (value: number) => new Date(value).toISOString();

export function McpTokenList({
  tokens,
  revokingId,
  onRevoke,
}: {
  tokens: McpToken[];
  revokingId: string | null;
  onRevoke: (token: McpToken) => void;
}) {
  const titleId = useId();

  return (
    <section className="mcp-token-section" aria-labelledby={titleId}>
      <div className="mcp-token-heading">
        <h3 id={titleId}>Active tokens</h3>
        {tokens.length > 0 && (
          <span className="mcp-count">
            {tokens.length} {tokens.length === 1 ? "token" : "tokens"}
          </span>
        )}
      </div>
      {tokens.length === 0 ? (
        <p className="mcp-empty">No tokens yet. Create one below to connect Claude Code, Cursor, or another MCP client.</p>
      ) : (
        <ul className="mcp-tokens">
          {tokens.map((token) => (
            <li className="mcp-token" key={token.id}>
              <div className="mcp-token-main">
                <div className="mcp-token-title">
                  <strong>{token.name}</strong>
                  <code className="mcp-token-prefix">{token.prefix}…</code>
                  <span className="mcp-scope-chip" data-scope={token.scope}>
                    {token.scope}
                  </span>
                </div>
                <div className="mcp-token-meta">
                  <span>
                    Created <time dateTime={timestamp(token.createdAt)}>{dateFormat.format(token.createdAt)}</time>
                  </span>
                  <span>
                    {token.lastUsedAt === null ? (
                      "Never used"
                    ) : (
                      <>
                        Last used <time dateTime={timestamp(token.lastUsedAt)}>{dateFormat.format(token.lastUsedAt)}</time>
                      </>
                    )}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="ghost bordered"
                aria-label={`Revoke ${token.name}`}
                disabled={revokingId !== null}
                onClick={() => onRevoke(token)}
              >
                {revokingId === token.id ? "Revoking…" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
