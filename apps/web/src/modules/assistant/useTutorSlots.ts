import { useCallback, useMemo, useRef, useState } from "react";
import type { ChatExcerpt } from "./excerpt";
import { LIBRARY_SLOT_KEY, bookSlotKey, moveToEnd, newSlot, pruneSlots } from "./tutorTypes";
import type { TutorSlot } from "./tutorTypes";
import type { ConversationSummary } from "./types";

/**
 * Slot descriptors for the tutor. Components own their conversation state; this
 * hook only decides which slots exist, which one is visible and their LRU order.
 */
export function useTutorSlots() {
  const [slots, setSlots] = useState<TutorSlot[]>([]);
  const [activeKey, setActiveKey] = useState(LIBRARY_SLOT_KEY);
  const [revision, setRevision] = useState(0);
  const slotsRef = useRef(slots);
  const activeKeyRef = useRef(activeKey);
  slotsRef.current = slots;
  activeKeyRef.current = activeKey;

  const ensureLibrarySlot = useCallback(() => {
    setSlots((current) =>
      current.some((slot) => slot.key === LIBRARY_SLOT_KEY) ? current : [...current, newSlot("library")],
    );
  }, []);

  const ensureBookSlot = useCallback((book: { id: string; title: string }) => {
    const key = bookSlotKey(book.id);
    setSlots((current) => {
      const index = current.findIndex((slot) => slot.key === key);
      if (index < 0) return pruneSlots([...current, newSlot("book", book)], activeKeyRef.current, key);
      const next = current.map((slot) => (slot.key === key ? { ...slot, bookTitle: book.title } : slot));
      return moveToEnd(next, key);
    });
    return key;
  }, []);

  const touch = useCallback((key: string) => {
    setSlots((current) => moveToEnd(current, key));
  }, []);

  const updateBookTitle = useCallback((bookId: string, title: string) => {
    setSlots((current) => {
      const index = current.findIndex((slot) => slot.kind === "book" && slot.bookId === bookId);
      if (index < 0 || current[index]?.bookTitle === title) return current;
      return current.map((slot) => (slot.bookId === bookId ? { ...slot, bookTitle: title } : slot));
    });
  }, []);

  const setSlotStreaming = useCallback((key: string, streaming: boolean) => {
    setSlots((current) => {
      const index = current.findIndex((slot) => slot.key === key);
      if (index < 0 || current[index]?.streaming === streaming) return current;
      const next = current.map((slot) => (slot.key === key ? { ...slot, streaming } : slot));
      return streaming ? next : pruneSlots(next, activeKeyRef.current);
    });
  }, []);

  const setExcerpt = useCallback((key: string, excerpt: ChatExcerpt | undefined, error?: string) => {
    setSlots((current) =>
      current.map((slot) =>
        slot.key === key ? { ...slot, excerpt, excerptError: excerpt ? undefined : error } : slot,
      ),
    );
  }, []);

  const clearExcerpt = useCallback((key: string) => {
    setSlots((current) =>
      current.map((slot) => (slot.key === key ? { ...slot, excerpt: undefined, excerptError: undefined } : slot)),
    );
  }, []);

  const rememberConversation = useCallback((key: string, summary: ConversationSummary) => {
    setSlots((current) =>
      current.map((slot) =>
        slot.key === key
          ? { ...slot, conversationId: summary.id, conversationTitle: summary.title }
          : slot,
      ),
    );
    setRevision((value) => value + 1);
  }, []);

  const selectConversation = useCallback((conversation: ConversationSummary) => {
    const key =
      conversation.scope.kind === "library" ? LIBRARY_SLOT_KEY : bookSlotKey(conversation.scope.bookId);
    if (slotsRef.current.find((slot) => slot.key === key)?.streaming) return false;
    setSlots((items) => {
      const exists = items.some((slot) => slot.key === key);
      const withSlot = exists
        ? items
        : pruneSlots(
            [
              ...items,
              newSlot(
                conversation.scope.kind,
                conversation.scope.kind === "book"
                  ? { id: conversation.scope.bookId, title: "" }
                  : undefined,
              ),
            ],
            activeKeyRef.current,
            key,
          );
      return moveToEnd(
        withSlot.map((slot) =>
          slot.key === key
            ? {
                ...slot,
                initialId: conversation.id,
                conversationId: conversation.id,
                conversationTitle: conversation.title,
                session: slot.session + 1,
                excerpt: undefined,
                excerptError: undefined,
              }
            : slot,
        ),
        key,
      );
    });
    setActiveKey(key);
    return true;
  }, []);

  const resetSlot = useCallback((key: string) => {
    setSlots((current) =>
      current.map((slot) =>
        slot.key === key
          ? {
              ...slot,
              initialId: undefined,
              conversationId: undefined,
              conversationTitle: undefined,
              excerpt: undefined,
              excerptError: undefined,
              session: slot.session + 1,
            }
          : slot,
      ),
    );
  }, []);

  const forgetConversation = useCallback((id: string) => {
    setSlots((current) =>
      current.map((slot) =>
        slot.conversationId === id || slot.initialId === id
          ? {
              ...slot,
              initialId: undefined,
              conversationId: undefined,
              conversationTitle: undefined,
              session: slot.session + 1,
            }
          : slot,
      ),
    );
    setRevision((value) => value + 1);
  }, []);

  const isConversationStreaming = useCallback(
    (id: string) =>
      slotsRef.current.some(
        (slot) => slot.streaming && (slot.conversationId === id || slot.initialId === id),
      ),
    [],
  );

  const activeSlot = slots.find((slot) => slot.key === activeKey);
  return useMemo(
    () => ({
      slots,
      activeKey,
      setActiveKey,
      activeSlot,
      revision,
      ensureLibrarySlot,
      ensureBookSlot,
      touch,
      updateBookTitle,
      setSlotStreaming,
      setExcerpt,
      clearExcerpt,
      rememberConversation,
      selectConversation,
      resetSlot,
      forgetConversation,
      isConversationStreaming,
    }),
    [
      slots,
      activeKey,
      activeSlot,
      revision,
      ensureLibrarySlot,
      ensureBookSlot,
      touch,
      updateBookTitle,
      setSlotStreaming,
      setExcerpt,
      clearExcerpt,
      rememberConversation,
      selectConversation,
      resetSlot,
      forgetConversation,
      isConversationStreaming,
    ],
  );
}
