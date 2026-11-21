import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { TutorContextValue } from "./TutorProvider";
import type { ConversationsState } from "./useConversations";
import type { ConversationSummary } from "./types";

/** Shared "New chat" and delete flow for the dock header, the history view and the /ask rail. */
export function useTutorConversationActions({
  tutor,
  list,
}: {
  tutor: TutorContextValue;
  list: ConversationsState;
}) {
  const { ask, dialog } = useConfirm();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const wantsFocus = useRef(false);
  const active = tutor.activeSlot;
  const streaming = Boolean(active?.streaming);
  const requestFocus = () => {
    wantsFocus.current = true;
    setFocusTick((value) => value + 1);
  };

  useEffect(() => {
    if (busy || streaming || !wantsFocus.current) return;
    wantsFocus.current = false;
    newButtonRef.current?.focus();
  }, [busy, streaming, focusTick]);

  const startNew = useCallback(async () => {
    if (busy || streaming) return;
    const id = active?.conversationId;
    if (!id) {
      tutor.resetSlot(tutor.activeKey);
      return;
    }
    const name = active?.kind === "book" ? active.bookTitle ?? "this book" : "your library";
    const confirmed = await ask({
      title: "Start a new chat?",
      message: (
        <>
          Your conversation about <strong>{name}</strong> will be deleted. This cannot be undone.
        </>
      ),
      confirmLabel: "New chat",
      danger: true,
    });
    if (!confirmed || tutor.activeSlot?.streaming) return;
    setBusy(true);
    setError("");
    try {
      await list.remove(id);
      tutor.forgetConversation(id);
      tutor.resetSlot(tutor.activeKey);
    } catch (value) {
      setError(formatError(value));
    } finally {
      requestFocus();
      setBusy(false);
    }
  }, [busy, streaming, active, tutor, list, ask]);

  const removeConversation = useCallback(
    async (conversation: ConversationSummary) => {
      if (busy || list.deletingIds.has(conversation.id)) return;
      if (tutor.isConversationStreaming(conversation.id)) return;
      const confirmed = await ask({
        title: "Delete conversation?",
        message: (
          <>
            <strong>{conversation.title}</strong> will be deleted. This cannot be undone.
          </>
        ),
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed || tutor.isConversationStreaming(conversation.id)) return;
      setError("");
      requestFocus();
      try {
        await list.remove(conversation.id);
        tutor.forgetConversation(conversation.id);
        requestFocus();
      } catch (value) {
        setError(formatError(value));
        requestFocus();
      }
    },
    [busy, list, tutor, ask],
  );

  return {
    startNew,
    removeConversation,
    dialog,
    error,
    busy,
    newButtonRef,
    newDisabled: streaming || busy,
  };
}
