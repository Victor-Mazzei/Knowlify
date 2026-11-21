import { LLM_STYLE_PROFILES } from "./llmStyles";
import {
  headerFieldId,
  LLM_CONVERSATION_VARIABLE,
  LLM_HEADER_LIMIT,
  LLM_HEADER_NAME_MAX,
  LLM_HEADER_VALUE_MAX,
} from "./llmHeaders";
import type { LlmSettingsView } from "./llmTypes";
import type { LlmHeadersDraft } from "./useLlmHeadersDraft";
import "./llmHeaders.css";

const errorId = (rowId: string, field: "name" | "value") => `${headerFieldId(rowId, field)}-error`;
const keepId = (rowId: string) => `${headerFieldId(rowId, "value")}-keep`;

export function LlmHeadersEditor({
  draft,
  view,
  url,
  disabled,
}: {
  draft: LlmHeadersDraft;
  view: LlmSettingsView;
  url: string;
  disabled: boolean;
}) {
  if (view.headers === undefined && view.headersState === undefined) return null;

  const profile = LLM_STYLE_PROFILES[draft.style];
  const unreadable = view.headersState === "unreadable";
  const needsValues = draft.needsValues(view, url);
  const atLimit = draft.rows.length >= LLM_HEADER_LIMIT;

  return (
    <details
      className="llm-headers"
      open={draft.open}
      onToggle={(event) => draft.setOpen(event.currentTarget.open)}
    >
      <summary>Custom headers ({draft.count})</summary>
      <p className="llm-help llm-headers-intro">
        Up to {LLM_HEADER_LIMIT} headers. Values are stored encrypted and never shown again.
      </p>
      {unreadable && (
        <p className="llm-field-error llm-headers-warning">
          The saved header values can't be read. Enter them again and save.
        </p>
      )}
      {needsValues && (
        <p className="llm-help llm-help-warn llm-headers-warning">
          The server URL changed origin. Enter the saved values again or remove the headers.
        </p>
      )}
      {draft.formError && (
        <p className="llm-field-error llm-headers-warning" role="alert">
          {draft.formError}
        </p>
      )}

      <div className="llm-headers-list">
        {draft.rows.map((row, index) => {
          const nameError = draft.errors[row.id]?.field === "name" ? draft.errors[row.id] : null;
          const valueError = draft.errors[row.id]?.field === "value" ? draft.errors[row.id] : null;
          const saved = row.hadValue && !row.value.trim() && !unreadable;
          const nameId = headerFieldId(row.id, "name");
          const valueId = headerFieldId(row.id, "value");
          const keepHint = saved ? keepId(row.id) : "";
          const valueDescribedBy = [keepHint, valueError ? errorId(row.id, "value") : ""]
            .filter(Boolean)
            .join(" ");

          return (
            <div className="llm-header-row" key={row.id}>
              <div className="llm-header-field">
                <label className="visually-hidden" htmlFor={nameId}>
                  Header {index + 1} name
                </label>
                <input
                  id={nameId}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Name"
                  value={row.name}
                  disabled={disabled}
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={nameError ? errorId(row.id, "name") : undefined}
                  onChange={(event) => draft.update(row.id, "name", event.target.value)}
                />
                {nameError && (
                  <span className="llm-field-error" id={errorId(row.id, "name")}>
                    {nameError.message}
                  </span>
                )}
              </div>
              <div className="llm-header-field">
                <label className="visually-hidden" htmlFor={valueId}>
                  Header {index + 1} value
                </label>
                <div className="llm-header-value">
                  <input
                    id={valueId}
                    type={draft.showValues ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={saved ? "Leave blank to keep the saved value" : "Value"}
                    value={row.value}
                    disabled={disabled}
                    aria-invalid={Boolean(valueError)}
                    aria-describedby={valueDescribedBy || undefined}
                    onChange={(event) => draft.update(row.id, "value", event.target.value)}
                  />
                  {saved && <span className="llm-badge">Saved</span>}
                </div>
                {saved && (
                  <span className="visually-hidden" id={keepId(row.id)}>
                    Leave blank to keep the saved value.
                  </span>
                )}
                {valueError && (
                  <span className="llm-field-error" id={errorId(row.id, "value")}>
                    {valueError.message}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="ghost bordered llm-header-remove"
                aria-label={`Remove header ${row.name.trim() || index + 1}`}
                disabled={disabled}
                onClick={() => draft.remove(row.id)}
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>

      {draft.rows.length === 0 && <p className="llm-help">No custom headers.</p>}

      <div className="llm-headers-tools">
        <button
          type="button"
          className="ghost bordered"
          disabled={disabled || atLimit}
          onClick={draft.add}
        >
          Add header
        </button>
        <button
          type="button"
          className="ghost llm-show-key"
          aria-pressed={draft.showValues}
          disabled={disabled}
          onClick={() => draft.setShowValues(!draft.showValues)}
        >
          {draft.showValues ? "Hide values" : "Show values"}
        </button>
        {atLimit && <span className="llm-help">Maximum of {LLM_HEADER_LIMIT} headers.</span>}
      </div>

      <p className="llm-help llm-headers-hint">
        Use {LLM_CONVERSATION_VARIABLE} in a value to send the current conversation ID.
      </p>
      <p className="llm-help llm-headers-hint">{profile.managedHelp}</p>
      <p className="llm-help llm-headers-hint">
        Names use 1–{LLM_HEADER_NAME_MAX} letters, digits, or token symbols. Values use 1–{LLM_HEADER_VALUE_MAX} visible
        ASCII characters.
      </p>
    </details>
  );
}
