import { useId, useRef, useState } from "react";
import { MCP_NAME_MAX, type McpScope } from "./mcpTypes";

const SCOPES: { value: McpScope; title: string; description: string }[] = [
  {
    value: "read",
    title: "Read only",
    description: "Search passages and list books, notes and tags.",
  },
  {
    value: "write_notes",
    title: "Read and write notes",
    description: "Read, create notes, and add or remove tags.",
  },
];

export function McpTokenForm({
  busy,
  onSave,
}: {
  busy: boolean;
  onSave: (name: string, scope: McpScope) => Promise<boolean>;
}) {
  const uid = useId();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<McpScope>("read");
  const [nameError, setNameError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const nameId = `${uid}-name`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Enter a name for this token.");
      input.current?.focus();
      return;
    }
    if (trimmed.length > MCP_NAME_MAX) {
      setNameError(`Use ${MCP_NAME_MAX} characters or fewer.`);
      input.current?.focus();
      return;
    }
    setNameError("");
    if (await onSave(trimmed, scope)) {
      setName("");
      setScope("read");
    }
  }

  return (
    <form className="mcp-form" aria-labelledby={`${uid}-title`} onSubmit={(event) => void submit(event)} noValidate>
      <h3 id={`${uid}-title`}>Create a token</h3>
      <div className="mcp-field">
        <label htmlFor={nameId}>Token name</label>
        <input
          id={nameId}
          ref={input}
          className="mcp-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={MCP_NAME_MAX}
          value={name}
          disabled={busy}
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => {
            setName(event.target.value);
            setNameError("");
          }}
        />
        <p className="mcp-hint" id={hintId}>
          A name you will recognize later, like Claude Code or Research.
        </p>
        {nameError && (
          <p className="mcp-field-error" id={errorId} role="alert">
            {nameError}
          </p>
        )}
      </div>

      <fieldset className="mcp-field mcp-scopes">
        <legend>Access</legend>
        <div className="mcp-scope-grid">
          {SCOPES.map((option) => (
            <label className="mcp-scope-option" data-checked={scope === option.value} key={option.value}>
              <input
                type="radio"
                name={`${uid}-scope`}
                value={option.value}
                checked={scope === option.value}
                disabled={busy}
                onChange={() => setScope(option.value)}
              />
              <span>
                <span className="mcp-scope-title">{option.title}</span>
                <span className="mcp-scope-desc">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mcp-form-actions">
        <p className="mcp-hint">The token is shown once, right after you create it.</p>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create token"}
        </button>
      </div>
    </form>
  );
}
