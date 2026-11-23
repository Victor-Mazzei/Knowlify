import { useCallback, useContext, useMemo } from "react";
import type { FormEvent } from "react";
import type { ApiFn } from "../../components/dialogs";
import { ChatStatusContext } from "../assistant/useChatStatus";
import { chatLimitsApi } from "./chatLimitsApi";
import type { ChatLimitsView } from "./chatLimitsApi";
import { useChatLimits } from "./useChatLimits";
import "../assistant/sessions.css";

const TITLE_ID = "set-chat-limits";

const statusOf = (view: ChatLimitsView) => {
  if (view.locked) return { state: "locked", label: "Managed by server" };
  if (view.source === "db") return { state: "ready", label: "Saved here" };
  if (view.source === "env") return { state: "ready", label: "From environment" };
  return { state: "idle", label: "Default" };
};

const sourceNote = (view: ChatLimitsView) => {
  if (view.locked) {
    return "The server environment controls this setting. Ask the server owner to change it.";
  }
  if (view.source === "db") return "This value is saved in Knowlify and overrides the server environment.";
  if (view.source === "env") return "Using the server environment. Saving here stores an override.";
  return "Using the default limit. Save a value to change it on this server.";
};

/** Settings → AI: the blocking session limit, with the count currently stored. */
export function ChatLimitsCard({ api }: { api: ApiFn }) {
  const chat = useContext(ChatStatusContext);
  const client = useMemo(() => chatLimitsApi(api), [api]);
  const onChanged = useCallback(() => {
    void chat?.refresh();
  }, [chat]);
  const limits = useChatLimits(client, onChanged);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void limits.save();
  }

  if (limits.loading) {
    return (
      <section className="setting-card chat-limits-card" aria-labelledby={TITLE_ID}>
        <h2 id={TITLE_ID}>Session limit</h2>
        <p className="muted" role="status">
          Loading session settings…
        </p>
      </section>
    );
  }

  if (limits.loadError) {
    return (
      <section className="setting-card chat-limits-card" aria-labelledby={TITLE_ID}>
        <h2 id={TITLE_ID}>Session limit</h2>
        <p className="error" role="alert">
          {limits.loadError}
        </p>
        <button className="ghost bordered" onClick={limits.reload}>
          Try again
        </button>
      </section>
    );
  }

  const view = limits.view;
  if (!view) return null;
  const status = statusOf(view);
  const disabled = view.locked || limits.busy !== null;

  return (
    <section className="setting-card chat-limits-card" aria-labelledby={TITLE_ID}>
      <div className="chat-limits-head">
        <div>
          <h2 id={TITLE_ID}>Session limit</h2>
          <p className="muted">How many saved tutor sessions this server keeps.</p>
        </div>
        <span className="llm-state chat-limits-state" data-state={status.state}>
          {status.label}
        </span>
      </div>
      <p className="chat-limits-count">
        {view.count} of {view.maxConversations} used
      </p>
      <p className="chat-limits-help">
        Sessions are never deleted automatically. When you reach the limit, you must delete one to start a new one.
      </p>
      <p className="chat-limits-source">{sourceNote(view)}</p>

      <form className="chat-limits-form" onSubmit={submit} noValidate>
        <div className="chat-limits-field">
          <label htmlFor="chat-max-sessions">Maximum sessions</label>
          <input
            id="chat-max-sessions"
            type="number"
            inputMode="numeric"
            min={view.min}
            max={view.max}
            step={1}
            value={limits.value}
            disabled={disabled}
            aria-invalid={limits.fieldError ? true : undefined}
            aria-describedby={`chat-max-sessions-help${limits.fieldError ? " chat-max-sessions-error" : ""}`}
            onChange={(event) => limits.setValue(event.target.value)}
          />
          <p id="chat-max-sessions-help" className="chat-limits-field-help">
            Choose a whole number from {view.min} to {view.max}.
          </p>
          {limits.fieldError && (
            <p id="chat-max-sessions-error" className="chat-limits-field-error" role="alert">
              {limits.fieldError}
            </p>
          )}
        </div>

        <div className="chat-limits-actions">
          <button className="primary" type="submit" disabled={!limits.dirty || disabled}>
            {limits.busy === "save" ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            className="ghost bordered"
            disabled={disabled || view.source === "default"}
            onClick={() => void limits.useDefault()}
          >
            {limits.busy === "default" ? "Restoring…" : "Use default"}
          </button>
          <div className="chat-limits-feedback" aria-live="polite">
            {limits.notice && (
              <p className="notice" role="status">
                {limits.notice}
              </p>
            )}
            {limits.error && (
              <p className="error" role="alert">
                {limits.error}
              </p>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
