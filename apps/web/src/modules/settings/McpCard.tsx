import { useMemo } from "react";
import type { ApiFn } from "../../components/dialogs";
import { useConfirm } from "../../components/dialogs";
import { CopyField } from "./CopyField";
import { endpointUrl, mcpApi } from "./mcpApi";
import { McpExamples } from "./McpExamples";
import { McpRevealDialog } from "./McpRevealDialog";
import { McpTokenForm } from "./McpTokenForm";
import { McpTokenList } from "./McpTokenList";
import { MCP_DEFAULT_PATH, MCP_TOKEN_LIMIT, type McpToken } from "./mcpTypes";
import { useMcpTokens } from "./useMcpTokens";
import "./mcp.css";

const TITLE_ID = "set-mcp";

function CardHead({ state, label }: { state: "ready" | "idle" | "off" | "attention"; label: string }) {
  return (
    <div className="mcp-head">
      <div>
        <h2 id={TITLE_ID}>MCP access</h2>
        <p className="muted">Connect an AI app to your library with a token.</p>
      </div>
      <span className="mcp-state" data-state={state}>
        {label}
      </span>
    </div>
  );
}

export function McpCard({ api }: { api: ApiFn }) {
  const client = useMemo(() => mcpApi(api), [api]);
  const state = useMcpTokens(client);
  const { ask, dialog } = useConfirm();
  const endpoint = endpointUrl(state.view?.path ?? MCP_DEFAULT_PATH);

  async function revoke(token: McpToken) {
    const ok = await ask({
      title: "Revoke token?",
      message: `“${token.name}” loses access immediately. This cannot be undone.`,
      confirmLabel: "Revoke token",
      danger: true,
    });
    if (ok) await state.revoke(token.id);
  }

  async function closeReveal() {
    const ok = await ask({
      title: "Close without saving the token?",
      message: "This token will not be shown again. If you did not copy it, revoke it and create a new one.",
      confirmLabel: "Close anyway",
      danger: true,
    });
    if (ok) state.dismissReveal();
  }

  if (state.status === "hidden") return null;

  if (state.status === "loading") {
    return (
      <section className="setting-card mcp-card" aria-labelledby={TITLE_ID}>
        <CardHead state="idle" label="Loading" />
        <p className="muted" role="status">
          Loading MCP access…
        </p>
        <div className="mcp-skeleton" aria-hidden="true">
          <span />
          <span />
        </div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="setting-card mcp-card" aria-labelledby={TITLE_ID}>
        <CardHead state="attention" label="Unavailable" />
        <div className="error mcp-feedback" role="alert">
          <span>{state.loadError}</span>
          <button type="button" className="ghost bordered" onClick={state.reload}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (state.status === "disabled" || state.view?.enabled === false) {
    return (
      <section className="setting-card mcp-card" aria-labelledby={TITLE_ID}>
        <CardHead state="off" label="Disabled" />
        <p className="mcp-disabled">
          MCP access is disabled by the server operator. Tokens and the <code>/mcp</code> endpoint are unavailable until
          the server owner sets <code>KNOWLIFY_MCP=on</code> and restarts it.
        </p>
      </section>
    );
  }

  const view = state.view;
  if (!view) return null;
  const isEmpty = view.items.length === 0;

  return (
    <section className="setting-card mcp-card" aria-labelledby={TITLE_ID}>
      <CardHead state={isEmpty ? "idle" : "ready"} label={isEmpty ? "No tokens" : `${view.items.length} active`} />
      <p className="mcp-warning">
        Passages and notes from your library are sent to the AI app that uses a token. Tokens with write access can also
        create notes and change tags.
      </p>
      <div className="mcp-endpoint">
        <CopyField label="Endpoint" value={endpoint} />
        <p className="mcp-hint">MCP clients authenticate with a token below, not your Knowlify password.</p>
      </div>

      <McpTokenList tokens={view.items} revokingId={state.revokingId} onRevoke={(token) => void revoke(token)} />

      {state.error && (
        <p className="error mcp-feedback" role="alert">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className="notice mcp-feedback" role="status">
          {state.notice}
        </p>
      )}

      {state.limitReached ? (
        <p className="mcp-limit" role="status">
          You have the maximum of {MCP_TOKEN_LIMIT} active tokens. Revoke one to create another.
        </p>
      ) : (
        <McpTokenForm busy={state.creating} onSave={state.create} />
      )}

      <McpExamples endpoint={endpoint} />

      {state.created && (
        <McpRevealDialog token={state.created} endpoint={endpoint} onRequestClose={() => void closeReveal()} />
      )}
      {dialog}
    </section>
  );
}
