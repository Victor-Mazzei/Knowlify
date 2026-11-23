import { useCallback } from "react";
import { ChatPanel } from "./ChatPanel";
import { useTutor } from "./TutorProvider";
import type { TutorSlot } from "./TutorProvider";
import type { ChatMessage, ChatStatus, ConversationSummary } from "./types";
import { useLatestSession } from "./useLatestSession";

const examplesFor = (slot: TutorSlot) =>
  slot.kind === "book"
    ? [
        "Explain this passage in plain language.",
        "What came before this point in the chapter?",
        "Give me an example that tests my understanding.",
      ]
    : [
        "What do my books say about habit formation?",
        "Explain the main argument of a book I am reading.",
        "Compare how two authors define attention.",
      ];

function SlotView({
  slot,
  status,
  disabledConversationIds,
}: {
  slot: TutorSlot;
  status: ChatStatus;
  disabledConversationIds?: ReadonlySet<string>;
}) {
  const tutor = useTutor();
  const registerTranscript = useCallback(
    (get: () => ChatMessage[]) => tutor.registerTranscript(slot.key, get),
    [tutor.registerTranscript, slot.key],
  );
  const resume = useCallback(
    (summary: ConversationSummary) => tutor.resumeSession(slot.key, summary),
    [tutor.resumeSession, slot.key],
  );
  const settled = useCallback(
    () => tutor.markResumeChecked(slot.key),
    [tutor.markResumeChecked, slot.key],
  );
  const startNewHere = useCallback(() => tutor.resetSlot(slot.key), [tutor.resetSlot, slot.key]);
  const shouldResume =
    slot.kind === "book" &&
    slot.mode === "session" &&
    !slot.conversationId &&
    !slot.initialId &&
    !slot.resumeChecked &&
    !slot.streaming &&
    Boolean(slot.bookId);

  useLatestSession({
    api: tutor.api,
    bookId: slot.bookId,
    enabled: shouldResume,
    onResume: resume,
    onSettled: settled,
  });

  const conversationId =
    slot.mode === "session" ? (slot.initialId ?? slot.conversationId) : undefined;
  return (
    <div className="tutor-slot" key={slot.key} data-tutor-slot={slot.key} hidden={slot.key !== tutor.activeKey}>
      {slot.excerptError && (
        <p className="tutor-context-error" role="alert">
          {slot.excerptError}
        </p>
      )}
      <ChatPanel
        key={slot.session}
        api={tutor.api}
        status={status}
        scope={
          slot.kind === "book" && slot.bookId
            ? { kind: "book", bookId: slot.bookId }
            : { kind: "library" }
        }
        conversationId={conversationId}
        onConversation={(summary) => tutor.rememberConversation(slot.key, summary)}
        onStreamingChange={(streaming) => tutor.setSlotStreaming(slot.key, streaming)}
        label={slot.kind === "book" ? "Book conversation" : "Library conversation"}
        examples={examplesFor(slot)}
        emptyTitle={
          slot.kind === "book" ? "Start with the passage in front of you." : "Start with a question"
        }
        emptyCopy={
          slot.kind === "book"
            ? "Select text and choose Ask about this, or ask from the current page."
            : "Ask about an idea, a theme, or a comparison across your books."
        }
        excerpt={slot.excerpt}
        onClearExcerpt={() => tutor.clearExcerpt(slot.key)}
        onUseVisibleText={
          slot.kind === "book" && slot.bookId === tutor.reader?.book.id
            ? () => tutor.useVisibleText(slot.key)
            : undefined
        }
        autoFocus={slot.key === tutor.activeKey}
        disabled={Boolean(slot.conversationId && disabledConversationIds?.has(slot.conversationId))}
        mode={slot.mode}
        modeSupported={tutor.modesSupported}
        useLibrary={slot.useLibrary}
        scopeLabel={slot.kind === "book" ? "This book" : "Whole library"}
        sessionTitle={slot.conversationTitle}
        sessionLimit={tutor.sessionLimit}
        onSessionLimit={tutor.reportSessionLimit}
        onStartNewSession={startNewHere}
        resumingTitle={slot.resumedTitle}
        registerTranscript={registerTranscript}
      />
    </div>
  );
}

/**
 * The mounted conversation slots. Inactive slots stay mounted and hidden so a
 * stream keeps running when the panel closes or the route changes; only the
 * session counter remounts one (new session, mode change or a saved session).
 */
export function TutorChats({
  hidden = false,
  disabledConversationIds,
}: {
  hidden?: boolean;
  /** Conversations with a pending delete: their composer must pause until the server answers. */
  disabledConversationIds?: ReadonlySet<string>;
}) {
  const tutor = useTutor();
  const status = tutor.status;
  if (!status) return <p className="muted tutor-checking">Checking chat…</p>;
  return (
    <div className="tutor-chats" hidden={hidden}>
      {tutor.slots.map((slot) => (
        <SlotView
          key={slot.key}
          slot={slot}
          status={status}
          disabledConversationIds={disabledConversationIds}
        />
      ))}
      {tutor.slots.length === 0 && <p className="muted tutor-checking">Starting the tutor…</p>}
    </div>
  );
}
