import { useEffect, useRef } from "react";
import { useDialogKeys } from "../../components/dialogs";
import { CopyField } from "./CopyField";
import { McpExamples } from "./McpExamples";
import type { McpCreatedToken } from "./mcpTypes";

/** One-time token reveal. Closing is confirmed by the card, never by this dialog. */
export function McpRevealDialog({
  token,
  endpoint,
  onRequestClose,
}: {
  token: McpCreatedToken;
  endpoint: string;
  onRequestClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useDialogKeys(ref, onRequestClose);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, summary");
    first?.focus();
    return () => {
      if (previous.current?.isConnected) previous.current.focus();
    };
  }, []);

  return (
    <div
      className="dialog-backdrop centered"
      onMouseDown={(event) => event.target === event.currentTarget && onRequestClose()}
    >
      <div
        ref={ref}
        className="confirm-dialog mcp-token-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-token-title"
        aria-describedby="mcp-token-copy"
      >
        <h2 id="mcp-token-title">Your new MCP token</h2>
        <p id="mcp-token-copy">Copy it now. This is the only time the token is shown.</p>
        <p className="mcp-token-meta-line">
          <strong>{token.name}</strong>
          <span>
            Scope: <code>{token.scope}</code>
          </span>
        </p>
        <CopyField label="Token" value={token.token} />
        <p className="mcp-warning">
          Passages and notes from your library are sent to the AI app you connect with this token.
        </p>
        <McpExamples endpoint={endpoint} token={token.token} />
        <div className="confirm-actions">
          <button type="button" className="primary" onClick={onRequestClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
