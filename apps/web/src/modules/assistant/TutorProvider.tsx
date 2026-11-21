import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { useApi } from "../../services/api";
import type { Credentials } from "../../types";
import { chatApi } from "./chatApi";
import type { ChatExcerpt } from "./excerpt";
import { TutorContext } from "./TutorContext";
import type { TutorContextValue } from "./TutorContext";
import { bookSlotKey, LIBRARY_SLOT_KEY } from "./tutorTypes";
import type { TutorReaderContext, TutorSurface, TutorView } from "./tutorTypes";
import { useChatStatusContextOptional } from "./useChatStatus";
import { useTutorSlots } from "./useTutorSlots";
import type { ConversationSummary } from "./types";

export { useRegisterTutorContext, useTutor, useTutorOptional } from "./TutorContext";
export { LIBRARY_SLOT_KEY, bookSlotKey } from "./tutorTypes";
export type { TutorReaderContext, TutorSlot, TutorSurface, TutorView } from "./tutorTypes";
export type { TutorContextValue } from "./TutorContext";

/**
 * Owns the global tutor: open state, conversation slots and the reader context.
 * Mounted above the routes so a streaming answer survives navigation.
 */
export function TutorProvider({
  credentials,
  onLogout,
  api: apiOverride,
  children,
}: {
  credentials: Credentials;
  onLogout: () => void;
  api?: ApiFn;
  children: ReactNode;
}) {
  const liveApi = useApi(credentials, onLogout);
  const api = chatApi(apiOverride ?? liveApi);
  const chat = useChatStatusContextOptional();
  const location = useLocation();
  const surface: TutorSurface = location.pathname === "/ask" ? "page" : "dock";
  const status = chat?.status ?? null;
  const enabled = status?.enabled ?? chat?.enabled ?? false;

  const slots = useTutorSlots();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TutorView>("chat");
  const [reader, setReader] = useState<TutorReaderContext | null>(null);
  const readerRef = useRef(reader);
  const readerToken = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  readerRef.current = reader;
  openRef.current = open;

  const rememberOpener = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const openSlot = useCallback(
    (key: string) => {
      if (!enabled) return;
      slots.touch(key);
      slots.setActiveKey(key);
      setView("chat");
      setOpen(true);
    },
    [enabled, slots],
  );

  const openTutor = useCallback(() => {
    if (!enabled) return;
    const context = readerRef.current;
    if (context && status?.scopes.book) {
      const key = slots.ensureBookSlot(context.book);
      rememberOpener();
      openSlot(key);
    } else if (!status || status.scopes.library) {
      slots.ensureLibrarySlot();
      rememberOpener();
      openSlot(LIBRARY_SLOT_KEY);
    }
  }, [enabled, status, slots, openSlot]);

  const closeTutor = useCallback(() => {
    setOpen(false);
    const element = opener.current;
    opener.current = null;
    if (!element?.isConnected) return;
    // A close triggered by another control (for example the reader's Notes button)
    // must leave focus there instead of pulling it back to the old opener.
    const active = document.activeElement;
    const panel = document.getElementById("tutor-panel");
    if (!active || active === document.body || active === element || panel?.contains(active)) {
      element.focus();
    }
  }, []);

  const toggleTutor = useCallback(() => {
    if (!openRef.current) {
      openTutor();
      return;
    }
    const context = readerRef.current;
    if (context && status?.scopes.book) {
      const key = slots.ensureBookSlot(context.book);
      if (slots.activeKey !== key) {
        slots.setActiveKey(key);
        return;
      }
    }
    closeTutor();
  }, [openTutor, closeTutor, status, slots]);

  const setMode = useCallback(
    (mode: "library" | "book") => {
      if (mode === "library") {
        if (!status?.scopes.library) return;
        slots.ensureLibrarySlot();
        slots.touch(LIBRARY_SLOT_KEY);
        slots.setActiveKey(LIBRARY_SLOT_KEY);
        return;
      }
      const context = readerRef.current;
      if (!context || !status?.scopes.book) return;
      slots.setActiveKey(slots.ensureBookSlot(context.book));
    },
    [status, slots],
  );

  const askAbout = useCallback(
    (excerpt: ChatExcerpt) => {
      const context = readerRef.current;
      if (!context || !status?.scopes.book) return;
      const key = slots.ensureBookSlot(context.book);
      slots.setExcerpt(key, excerpt);
      rememberOpener();
      openSlot(key);
    },
    [status, slots, openSlot],
  );

  const useVisibleText = useCallback(
    (key: string) => {
      const context = readerRef.current;
      const text = context?.visibleText?.() ?? "";
      if (!text.trim()) {
        slots.setExcerpt(key, undefined, "No page text is available here.");
        return;
      }
      slots.setExcerpt(key, {
        text,
        kind: "visible",
        ...(context?.page ? { page: context.page } : {}),
        ...(context?.section ? { section: context.section } : {}),
      });
    },
    [slots],
  );

  const selectConversation = useCallback(
    (conversation: ConversationSummary) => {
      const scope = conversation.scope;
      if (scope.kind === "library" ? !status?.scopes.library : !status?.scopes.book) return;
      if (scope.kind === "library") slots.ensureLibrarySlot();
      if (!slots.selectConversation(conversation)) return;
      setView("chat");
      setOpen(true);
    },
    [status, slots],
  );

  const registerReaderContext = useCallback(
    (context: TutorReaderContext) => {
      const token = ++readerToken.current;
      setReader(context);
      slots.updateBookTitle(context.book.id, context.book.title);
      return () => {
        if (readerToken.current === token) setReader(null);
      };
    },
    [slots],
  );

  // Chat is hidden from every page while the provider loads a server without a model.
  useLayoutEffect(() => {
    if (!chat?.loading && !enabled) {
      setOpen(false);
      return;
    }
    if (status && !status.enabled) {
      setOpen(false);
      return;
    }
    if (surface === "page") {
      if (status?.scopes.library) slots.ensureLibrarySlot();
      slots.setActiveKey(LIBRARY_SLOT_KEY);
      return;
    }
    if (location.pathname.startsWith("/read/")) return;
    if (status && !status.scopes.library && !readerRef.current) {
      setOpen(false);
      return;
    }
    if (slots.activeKey !== LIBRARY_SLOT_KEY) {
      if (status?.scopes.library) {
        slots.ensureLibrarySlot();
        slots.setActiveKey(LIBRARY_SLOT_KEY);
      } else {
        setOpen(false);
      }
    }
  }, [status, enabled, chat?.loading, surface, location.pathname, slots]);

  const value: TutorContextValue = {
    api,
    status,
    enabled,
    loading: chat?.loading ?? false,
    open,
    surface,
    view,
    reader,
    slots: slots.slots,
    activeKey: slots.activeKey,
    activeSlot: slots.activeSlot,
    revision: slots.revision,
    openTutor,
    closeTutor,
    toggleTutor,
    setView,
    setMode,
    askAbout,
    useVisibleText,
    clearExcerpt: slots.clearExcerpt,
    selectConversation,
    rememberConversation: slots.rememberConversation,
    setSlotStreaming: slots.setSlotStreaming,
    resetSlot: slots.resetSlot,
    forgetConversation: slots.forgetConversation,
    isConversationStreaming: slots.isConversationStreaming,
    registerReaderContext,
  };
  return <TutorContext.Provider value={value}>{children}</TutorContext.Provider>;
}
