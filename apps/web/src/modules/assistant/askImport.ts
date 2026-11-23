import type { ChatMessage, ImportedMessage } from "./types";

/** Mirrors the `POST /api/chat/conversations` import bounds in the HTTP contract. */
export const MAX_IMPORTED_MESSAGES = 20;
export const MAX_IMPORTED_USER_CHARS = 2_000;
export const MAX_IMPORTED_ASSISTANT_CHARS = 8_000;

export type AskImportPlan = {
  /** Every visible message, in order. Empty only when the transcript cannot be imported as-is. */
  messages: ImportedMessage[];
  /** Non-empty messages in the Ask transcript, including messages the route cannot take. */
  transcriptMessages: number;
  /** Partial answers kept after Stop or a failure; they are imported exactly as shown. */
  incompleteAnswers: number;
  /** Trailing questions with no answer; the import route only takes complete pairs. */
  unansweredQuestions: number;
  /** The full transcript is longer than the route's import limit. */
  overLimit: boolean;
  /** A single message is longer than the route's per-message import bound. */
  oversized: "question" | "answer" | null;
  /** The transcript is not a question/answer sequence starting with a question. */
  malformed: boolean;
  /** The newest complete messages that fit the limit, for an explicit opt-in. */
  lastMessages: ImportedMessage[];
  /** Complete messages the opt-in would leave out. */
  droppedMessages: number;
  canSave: boolean;
};

const roleAt = (index: number): ChatMessage["role"] => (index % 2 === 0 ? "user" : "assistant");

/**
 * Decides what "Save as session" can import without dropping messages.
 * The route takes at most 20 alternating messages; an oversized transcript is
 * reported as blocked instead of being sliced down to its newest turns.
 */
export function planAskImport(messages: ChatMessage[]): AskImportPlan {
  const visible = messages.filter((message) => message.content.trim());
  let completeEnd = visible.length;
  while (completeEnd > 0 && visible[completeEnd - 1]?.role === "user") completeEnd -= 1;
  const complete = visible.slice(0, completeEnd);
  const unansweredQuestions = visible.length - completeEnd;
  const malformed = complete.some((message, index) => message.role !== roleAt(index));
  const oversized =
    complete.find(
      (message, index) =>
        message.content.trim().length >
        (roleAt(index) === "user" ? MAX_IMPORTED_USER_CHARS : MAX_IMPORTED_ASSISTANT_CHARS),
    ) ?? null;
  const imported: ImportedMessage[] = malformed
    ? []
    : complete.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.citations?.length ? { citations: message.citations } : {}),
      }));
  const overLimit = visible.length > MAX_IMPORTED_MESSAGES;
  const lastMessages =
    malformed || oversized
      ? []
      : imported.slice(Math.max(0, imported.length - MAX_IMPORTED_MESSAGES));
  return {
    messages: imported,
    transcriptMessages: visible.length,
    incompleteAnswers: complete.filter((message) => message.role === "assistant" && message.incomplete).length,
    unansweredQuestions,
    overLimit,
    oversized: oversized ? (oversized.role === "user" ? "question" : "answer") : null,
    malformed,
    lastMessages,
    droppedMessages: imported.length - lastMessages.length,
    canSave: !overLimit && !oversized && !malformed && imported.length >= 2,
  };
}
