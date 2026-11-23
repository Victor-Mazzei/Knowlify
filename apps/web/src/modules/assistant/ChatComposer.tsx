import { useId } from "react";
import type { ReactNode, RefObject } from "react";
import type { ChatExcerpt } from "./excerpt";
import type { ChatMode } from "./types";

export function ChatComposer({
  draft,
  onDraft,
  onSubmit,
  onStop,
  streaming,
  host,
  excerpt,
  onClearExcerpt,
  onUseVisibleText,
  inputRef,
  disabled = false,
  mode = "session",
  useLibrary = true,
  libraryAvailable = true,
  recommendControl,
}: {
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: (question: string) => void;
  onStop: () => void;
  streaming: boolean;
  host: string | null;
  excerpt?: ChatExcerpt;
  onClearExcerpt?: () => void;
  onUseVisibleText?: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  mode?: ChatMode;
  /** Ask only: when false, no passages are retrieved or sent. */
  useLibrary?: boolean;
  /** False when the server has no search index: no passages are retrieved in any mode. */
  libraryAvailable?: boolean;
  /** Ask + whole library: the book suggestion controls, rendered with the question field. */
  recommendControl?: ReactNode;
}) {
  const inputId = useId();
  const privacyId = useId();
  const preview = excerpt && excerpt.text.length > 240 ? `${excerpt.text.slice(0, 240)}…` : excerpt?.text;
  const searchesLibrary = libraryAvailable && (mode === "session" || useLibrary);

  const submit = () => {
    const question = draft.trim();
    if (!question || streaming || disabled) return;
    onSubmit(question);
  };

  return (
    <form
      className="asst-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {excerpt && preview && (
        <div className="asst-excerpt">
          <div>
            <p>
              <span className="asst-excerpt-kind">
                {excerpt.kind === "selection" ? "Selected text" : "Page text"}
              </span>
              {preview}
            </p>
            <p className="asst-excerpt-sent">Attached text is sent to the model.</p>
          </div>
          {onClearExcerpt && (
            <button type="button" className="ghost" onClick={onClearExcerpt}>
              Remove
            </button>
          )}
        </div>
      )}
      <label className="asst-visually-hidden" htmlFor={inputId}>
        Your question
      </label>
      <textarea
        id={inputId}
        ref={inputRef}
        className="asst-input"
        rows={2}
        maxLength={2000}
        placeholder={mode === "ask" && !useLibrary ? "Ask a question…" : "Ask about your books…"}
        aria-describedby={privacyId}
        value={draft}
        disabled={disabled}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {recommendControl}
      <div className="asst-composer-actions">
        <p className="asst-privacy" id={privacyId}>
          {searchesLibrary
            ? "Your question and the retrieved passages are sent to "
            : "Your question and any attached text are sent to "}
          <span className="asst-host">{host ?? "the configured model provider"}</span>.
        </p>
        <div className="asst-composer-buttons">
          {onUseVisibleText && !excerpt && (
            <button type="button" className="ghost" onClick={onUseVisibleText}>
              Use page text
            </button>
          )}
          {streaming ? (
            <button type="button" className="ghost bordered" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={disabled || !draft.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
