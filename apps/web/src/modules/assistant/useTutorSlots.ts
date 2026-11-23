import { useCallback, useMemo, useRef, useState } from "react";
import { readAskUseLibrary, readTutorMode, readTutorRecommend } from "../../services/storage";
import type { ChatExcerpt } from "./excerpt";
import { LIBRARY_SLOT_KEY, bookSlotKey, moveToEnd, newSlot, pruneSlots } from "./tutorTypes";
import type { TutorSlot } from "./tutorTypes";
import type { ChatMode, ConversationSummary, RecommendPreference } from "./types";

/**
 * Slot descriptors for the tutor. Components own their conversation state; this
 * hook only decides which slots exist, which one is visible, their mode and their
 * LRU order.
 */
export function useTutorSlots({ modesSupported }: { modesSupported: boolean }) {
  const [slots, setSlots] = useState<TutorSlot[]>([]);
  const [activeKey, setActiveKey] = useState(LIBRARY_SLOT_KEY);
  const [revision, setRevision] = useState(0);
  const slotsRef = useRef(slots);
  const activeKeyRef = useRef(activeKey);
  const modesRef = useRef(modesSupported);
  slotsRef.current = slots;
  activeKeyRef.current = activeKey;
  modesRef.current = modesSupported;

  const defaults = useCallback(
    () => ({
      mode: modesRef.current ? readTutorMode() : ("session" as const),
      useLibrary: readAskUseLibrary(),
      recommend: readTutorRecommend(),
    }),
    [],
  );

  const ensureLibrarySlot = useCallback(() => {
    setSlots((current) =>
      current.some((slot) => slot.key === LIBRARY_SLOT_KEY)
        ? current
        : [...current, newSlot("library", undefined, defaults())],
    );
  }, [defaults]);

  const ensureBookSlot = useCallback(
    (book: { id: string; title: string }) => {
      const key = bookSlotKey(book.id);
      setSlots((current) => {
        const index = current.findIndex((slot) => slot.key === key);
        if (index < 0)
          return pruneSlots([...current, newSlot("book", book, defaults())], activeKeyRef.current, key);
        const next = current.map((slot) => (slot.key === key ? { ...slot, bookTitle: book.title } : slot));
        return moveToEnd(next, key);
      });
      return key;
    },
    [defaults],
  );

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

  const setSlotMode = useCallback((key: string, mode: ChatMode) => {
    setSlots((current) =>
      current.map((slot) =>
        slot.key === key && slot.mode !== mode
          ? { ...slot, mode, resumedTitle: undefined, session: slot.session + 1 }
          : slot,
      ),
    );
  }, []);

  const setSlotUseLibrary = useCallback((key: string, useLibrary: boolean) => {
    setSlots((current) =>
      current.map((slot) => (slot.key === key ? { ...slot, useLibrary } : slot)),
    );
  }, []);

  const setSlotRecommend = useCallback((key: string, recommend: RecommendPreference) => {
    setSlots((current) =>
      current.map((slot) => (slot.key === key ? { ...slot, recommend } : slot)),
    );
  }, []);

  const rememberConversation = useCallback((key: string, summary: ConversationSummary) => {
    setSlots((current) =>
      current.map((slot) => {
        if (slot.key !== key) return slot;
        // A rename during the stream wins over the stale `done.title` of an existing session.
        const keepTitle = slot.conversationId === summary.id && Boolean(slot.conversationTitle);
        return {
          ...slot,
          conversationId: summary.id,
          conversationTitle: keepTitle && slot.conversationTitle ? slot.conversationTitle : summary.title,
        };
      }),
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
                defaults(),
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
                mode: "session",
                initialId: conversation.id,
                conversationId: conversation.id,
                conversationTitle: conversation.title,
                resumedTitle: undefined,
                resumeChecked: true,
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
  }, [defaults]);

  const resumeSession = useCallback((key: string, summary: ConversationSummary) => {
    setSlots((current) =>
      current.map((slot) => {
        if (slot.key !== key) return slot;
        // A late lookup must not pull a person out of Ask or replace a session they opened.
        if (slot.mode !== "session" || slot.conversationId || slot.initialId) {
          return { ...slot, resumeChecked: true };
        }
        return {
          ...slot,
          mode: "session",
          initialId: summary.id,
          conversationId: summary.id,
          conversationTitle: summary.title,
          resumedTitle: summary.title,
          resumeChecked: true,
          session: slot.session + 1,
        };
      }),
    );
  }, []);

  const markResumeChecked = useCallback((key: string) => {
    setSlots((current) =>
      current.map((slot) => (slot.key === key ? { ...slot, resumeChecked: true } : slot)),
    );
  }, []);

  const renameConversation = useCallback((id: string, title: string) => {
    setSlots((current) =>
      current.map((slot) =>
        slot.conversationId === id || slot.initialId === id
          ? {
              ...slot,
              conversationTitle: title,
              ...(slot.resumedTitle ? { resumedTitle: title } : {}),
            }
          : slot,
      ),
    );
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
              resumedTitle: undefined,
              resumeChecked: true,
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
              resumedTitle: undefined,
              resumeChecked: true,
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
      setSlotMode,
      setSlotUseLibrary,
      setSlotRecommend,
      rememberConversation,
      selectConversation,
      resumeSession,
      markResumeChecked,
      renameConversation,
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
      setSlotMode,
      setSlotUseLibrary,
      setSlotRecommend,
      rememberConversation,
      selectConversation,
      resumeSession,
      markResumeChecked,
      renameConversation,
      resetSlot,
      forgetConversation,
      isConversationStreaming,
    ],
  );
}
