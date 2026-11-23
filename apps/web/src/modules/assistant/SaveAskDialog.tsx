import { useEffect, useId, useRef } from "react";
import { useDialogKeys } from "../../components/dialogs";
import {
  MAX_IMPORTED_ASSISTANT_CHARS,
  MAX_IMPORTED_MESSAGES,
  MAX_IMPORTED_USER_CHARS,
} from "./askImport";

/**
 * Shown when an Ask transcript with questions would be discarded (mode change,
 * scope change, "New session" or opening a saved session). Saving imports the
 * transcript as a Session; discarding drops it; Cancel keeps it.
 */
export function SaveAskDialog({
  scopeLabel,
  questionCount,
  messageCount = 0,
  maxMessages = MAX_IMPORTED_MESSAGES,
  overLimit = false,
  oversized = null,
  malformed = false,
  incompleteAnswers = 0,
  unansweredQuestions = 0,
  lastMessageCount = 0,
  droppedMessages = 0,
  canSave,
  saving,
  error,
  onSave,
  onSaveLast,
  onDiscard,
  onCancel,
}: {
  scopeLabel: string;
  questionCount: number;
  /** Non-empty messages in the whole Ask transcript, including ones the import cannot take. */
  messageCount?: number;
  maxMessages?: number;
  /** The whole transcript is longer than the import route allows. */
  overLimit?: boolean;
  oversized?: "question" | "answer" | null;
  /** The transcript is not an alternating question/answer sequence. */
  malformed?: boolean;
  /** Partial answers kept after Stop or a failure; they are still imported as shown. */
  incompleteAnswers?: number;
  unansweredQuestions?: number;
  /** Complete messages the opt-in would save (at most `maxMessages`). */
  lastMessageCount?: number;
  /** Complete messages the opt-in leaves out. */
  droppedMessages?: number;
  canSave: boolean;
  saving: boolean;
  error: string;
  onSave: () => void;
  /** Explicit opt-in: save only the newest complete messages that fit. */
  onSaveLast?: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previous = useRef<Element | null>(document.activeElement);
  const titleId = useId();
  const copyId = useId();
  const blocked = overLimit || oversized !== null || malformed;
  const canSaveLast =
    Boolean(onSaveLast) && overLimit && !oversized && !malformed && lastMessageCount >= 2;
  useDialogKeys(ref, () => {
    if (!saving) onCancel();
  });

  useEffect(() => {
    cancelRef.current?.focus();
    const opener = previous.current as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);

  return (
    <div
      className="dialog-backdrop centered"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <div
        ref={ref}
        className="confirm-dialog save-ask-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={copyId}
      >
        <h2 id={titleId}>This Ask chat is not saved.</h2>
        <div id={copyId} className="confirm-message">
          <p>
            {blocked
              ? `${questionCount === 1 ? "This question is" : `These ${questionCount} questions are`} not saved, and this chat cannot be saved as one session.`
              : `${questionCount === 1 ? "This question is" : `These ${questionCount} questions are`} not saved. ${questionCount === 1 ? "Keep it" : "Keep them"} as a session about ${scopeLabel}, or ${questionCount === 1 ? "discard it" : "discard them"}.`}
          </p>
          {overLimit && (
            <p className="error save-ask-error" role="alert">
              This chat has {messageCount} messages. A session can save at most {maxMessages} messages, so
              Save as session is disabled and nothing was saved.{" "}
              {canSaveLast && `You can save the newest ${lastMessageCount} messages. `}
              {canSaveLast &&
                droppedMessages > 0 &&
                `The ${droppedMessages} oldest ${droppedMessages === 1 ? "message" : "messages"} will not be saved. `}
              Cancel keeps this chat. Discard deletes it.
            </p>
          )}
          {oversized && (
            <p className="error save-ask-error" role="alert">
              {oversized === "question"
                ? `A question in this chat is longer than ${MAX_IMPORTED_USER_CHARS.toLocaleString("en-US")} characters.`
                : `An answer in this chat is longer than ${MAX_IMPORTED_ASSISTANT_CHARS.toLocaleString("en-US")} characters.`}{" "}
              Nothing was saved. Cancel keeps this chat. Discard deletes it.
            </p>
          )}
          {malformed && (
            <p className="error save-ask-error" role="alert">
              This chat is not a question-and-answer sequence, so you cannot save it as a session. Nothing
              was saved. Cancel keeps this chat. Discard deletes it.
            </p>
          )}
          {!malformed && !oversized && incompleteAnswers > 0 && (
            <p className="muted">
              {incompleteAnswers === 1
                ? "The session will include 1 partial answer exactly as it appears."
                : `The session will include ${incompleteAnswers} partial answers exactly as they appear.`}
            </p>
          )}
          {!malformed && !oversized && unansweredQuestions > 0 && (
            <p className="muted">
              {unansweredQuestions === 1
                ? "The last question has no answer yet. It will not be included."
                : `${unansweredQuestions} questions have no answer yet. They will not be included.`}
            </p>
          )}
          {!canSave && !blocked && (
            <p className="muted">Ask a question and get an answer before saving this chat.</p>
          )}
        </div>
        {error && (
          <p className="error save-ask-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions save-ask-actions">
          <button ref={cancelRef} type="button" className="ghost bordered" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="ghost bordered" disabled={saving} onClick={onDiscard}>
            Discard
          </button>
          {canSaveLast && (
            <button
              type="button"
              className="ghost bordered"
              aria-describedby={copyId}
              disabled={saving}
              onClick={onSaveLast}
            >
              {saving ? "Saving…" : `Save last ${lastMessageCount} messages`}
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={saving || !canSave || blocked}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save as session"}
          </button>
        </div>
      </div>
    </div>
  );
}
