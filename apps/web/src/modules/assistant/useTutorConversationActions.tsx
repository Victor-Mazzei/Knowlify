import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { TutorContextValue } from "./TutorProvider";
import type { ConversationsState } from "./useConversations";
import type { ConversationSummary } from "./types";

/** Shared "New session" and delete flow for the dock header, the sessions view and the /ask rail. */
export function useTutorConversationActions({
  tutor,
  lists,
}: {
  tutor: TutorContextValue;
  lists: ConversationsState[];
}) {
  const { ask, dialog } = useConfirm();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const wantsFocus = useRef(false);
  const active = tutor.activeSlot;
  const streaming = Boolean(active?.streaming);
  const listsRef = useRef(lists);
  listsRef.current = lists;
  const requestFocus = () => {
    wantsFocus.current = true;
    setFocusTick((value) => value + 1);
  };

  useEffect(() => {
    if (busy || streaming || !wantsFocus.current) return;
    wantsFocus.current = false;
    newButtonRef.current?.focus();
  }, [busy, streaming, focusTick]);

  const listFor = (id: string) =>
    listsRef.current.find((list) => list.conversations.some((item) => item.id === id)) ??
    listsRef.current[0];

  const startNew = useCallback(() => {
    if (busy || streaming) return;
    tutor.startNewSession();
  }, [busy, streaming, tutor]);

  const removeConversation = useCallback(
    async (conversation: ConversationSummary) => {
      const list = listFor(conversation.id);
      if (!list) return;
      if (busy || list.deletingIds.has(conversation.id)) return;
      if (tutor.isConversationStreaming(conversation.id)) return;
      const confirmed = await ask({
        title: "Delete session?",
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
        tutor.clearSessionLimit();
        tutor.refreshStatus();
        requestFocus();
      } catch (value) {
        setError(formatError(value));
        requestFocus();
      }
    },
    [busy, tutor, ask],
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
