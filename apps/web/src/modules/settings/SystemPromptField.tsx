import type { LlmApi } from "./llmApi";
import type { LlmPromptView } from "./llmTypes";
import { usePromptSettings } from "./usePromptSettings";

const HELP_ID = "llm-prompt-help";
const COUNT_ID = "llm-prompt-count";
const ERROR_ID = "llm-prompt-error";
const LOCKED_ID = "llm-prompt-locked";

/**
 * Editable persona inside the AI assistant card. Saving here is separate from the
 * connection form, and the fixed safety envelope is not offered for editing.
 */
export function SystemPromptField({ client, prompt }: { client: LlmApi; prompt: LlmPromptView }) {
  const state = usePromptSettings(client, prompt);
  const current = state.prompt;
  const shownError = state.error || state.problem;
  const describedBy = [
    HELP_ID,
    COUNT_ID,
    current.locked ? LOCKED_ID : null,
    shownError ? ERROR_ID : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className="llm-prompt" aria-labelledby="llm-prompt-title">
      <div className="llm-prompt-head">
        <h3 id="llm-prompt-title">System prompt</h3>
        <span className="llm-prompt-state" data-custom={!state.usingDefault}>
          {state.usingDefault ? "Using default" : "Custom"}
        </span>
      </div>
      <p className="llm-help" id={HELP_ID}>
        Citation and safety rules are always applied and can't be changed.
      </p>

      <form
        className="llm-prompt-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void state.save();
        }}
      >
        <div className="llm-field">
          <label htmlFor="llm-system-prompt">Prompt</label>
          <textarea
            id="llm-system-prompt"
            rows={8}
            maxLength={current.maxChars}
            value={state.draft}
            disabled={current.locked || state.saving}
            aria-invalid={Boolean(state.problem)}
            aria-describedby={describedBy}
            onChange={(event) => state.change(event.target.value)}
          />
          {current.locked && (
            <span className="llm-help" id={LOCKED_ID}>
              Managed by the server environment
            </span>
          )}
        </div>

        <div className="llm-prompt-meta">
          <span className="llm-prompt-count" id={COUNT_ID}>
            {state.draft.length} / {current.maxChars}
          </span>
        </div>

        {shownError && (
          <p className="error" id={ERROR_ID} role="alert">
            {shownError}
          </p>
        )}

        <div className="llm-prompt-actions">
          <button
            type="button"
            className="ghost bordered"
            disabled={current.locked || state.saving}
            onClick={state.reset}
          >
            Reset to default
          </button>
          <button type="submit" className="primary" disabled={!state.canSave}>
            {state.saving ? "Saving…" : "Save prompt"}
          </button>
        </div>

        <div className="llm-prompt-feedback" aria-live="polite">
          {state.notice && <p className="notice">{state.notice}</p>}
        </div>
      </form>

      <details className="llm-prompt-default">
        <summary>View default</summary>
        <pre>{current.default}</pre>
      </details>
    </section>
  );
}
