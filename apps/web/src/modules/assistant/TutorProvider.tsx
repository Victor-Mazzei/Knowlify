import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, useApi } from "../../services/api";
import { saveAskUseLibrary, saveTutorMode } from "../../services/storage";
import type { Credentials } from "../../types";
import { MAX_IMPORTED_MESSAGES, planAskImport } from "./askImport";
import { chatApi } from "./chatApi";
import type { ChatExcerpt } from "./excerpt";
import { SaveAskDialog } from "./SaveAskDialog";
import { TutorContext } from "./TutorContext";
import type { TutorContextValue } from "./TutorContext";
import { bookSlotKey, LIBRARY_SLOT_KEY } from "./tutorTypes";
import type { TutorReaderContext, TutorSlot, TutorSurface, TutorView } from "./tutorTypes";
import { useChatStatusContextOptional } from "./useChatStatus";
import type { ChatLimitDetails } from "./useChat";
import { useTutorSlots } from "./useTutorSlots";
import type {
  ChatMessage,
  ChatMode,
  ChatScope,
  ChatStatus,
  ConversationSummary,
  SaveConversationRequest,
} from "./types";

export { useRegisterTutorContext, useTutor, useTutorOptional } from "./TutorContext";
export { LIBRARY_SLOT_KEY, bookSlotKey } from "./tutorTypes";
export type { TutorReaderContext, TutorSlot, TutorSurface, TutorView } from "./tutorTypes";
export type { TutorContextValue } from "./TutorContext";

type AskIntent =
  | { kind: "mode"; mode: ChatMode }
  | { kind: "scope"; scope: "library" | "book" }
  | { kind: "new" }
  | { kind: "select"; conversation: ConversationSummary };

type PendingAsk = {
  slotKey: string;
  scope: ChatScope;
  messages: ChatMessage[];
  intent: AskIntent;
};

const slotScope = (slot: TutorSlot): ChatScope =>
  slot.kind === "book" && slot.bookId
    ? { kind: "book", bookId: slot.bookId }
    : { kind: "library" };

/**
 * Owns the global tutor: open state, conversation slots, the reader context and
 * the Ask-to-Session guard. Mounted above the routes so a streaming answer
 * survives navigation.
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
  const modesSupported = Boolean(enabled && status?.modes?.includes("ask"));

  const slots = useTutorSlots({ modesSupported });
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TutorView>("chat");
  const [reader, setReader] = useState<TutorReaderContext | null>(null);
  const [limitHit, setLimitHit] = useState<{ limit: number; count: number } | null>(null);
  /** Status snapshot the 409 answered, so a stale cached count cannot clear it. */
  const limitStatusRef = useRef<ChatStatus | null>(null);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const [savingAsk, setSavingAsk] = useState(false);
  const [saveAskError, setSaveAskError] = useState("");
  const readerRef = useRef(reader);
  const readerToken = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  const transcripts = useRef(new Map<string, () => ChatMessage[]>());
  readerRef.current = reader;
  openRef.current = open;

  const limits = status?.sessionLimits;
  const sessionLimit =
    limits && limits.count >= limits.maxSessions
      ? { limit: limits.maxSessions, count: limits.count }
      : limitHit;

  // A refreshed status with room again clears a 409; the status snapshot that
  // produced the 409 is ignored because its cached count may still show room.
  useEffect(() => {
    if (!limitHit || !limits) return;
    if (status === limitStatusRef.current) return;
    if (limits.count < limits.maxSessions) setLimitHit(null);
  }, [limitHit, limits, status]);

  const transcriptFor = useCallback(
    (key: string) => transcripts.current.get(key)?.() ?? [],
    [],
  );
  const hasAskQuestions = useCallback(
    (key: string) => transcriptFor(key).some((message) => message.role === "user"),
    [transcriptFor],
  );

  const registerTranscript = useCallback((key: string, get: () => ChatMessage[]) => {
    transcripts.current.set(key, get);
    return () => {
      if (transcripts.current.get(key) === get) transcripts.current.delete(key);
    };
  }, []);

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

  const switchScope = useCallback(
    (scope: "library" | "book") => {
      if (scope === "library") {
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

  const openAskGuard = useCallback(
    (intent: AskIntent) => {
      const active = slots.activeSlot;
      if (!active) return;
      setSaveAskError("");
      setPendingAsk({
        slotKey: active.key,
        scope: slotScope(active),
        messages: transcriptFor(active.key),
        intent,
      });
    },
    [slots.activeSlot, transcriptFor],
  );

  const setMode = useCallback(
    (mode: "library" | "book") => {
      if (mode === "library") {
        if (!status?.scopes.library) return;
        if (slots.activeSlot?.mode === "ask" && slots.activeSlot.kind === "book" && hasAskQuestions(slots.activeSlot.key)) {
          openAskGuard({ kind: "scope", scope: "library" });
          return;
        }
        switchScope("library");
        return;
      }
      const context = readerRef.current;
      if (!context || !status?.scopes.book) return;
      if (slots.activeSlot?.mode === "ask" && slots.activeSlot.kind === "library" && hasAskQuestions(slots.activeSlot.key)) {
        openAskGuard({ kind: "scope", scope: "book" });
        return;
      }
      switchScope("book");
    },
    [status, slots.activeSlot, hasAskQuestions, openAskGuard, switchScope],
  );

  const setChatMode = useCallback(
    (mode: ChatMode) => {
      const active = slots.activeSlot;
      if (!active || !modesSupported || active.mode === mode) return;
      if (active.mode === "ask" && mode === "session" && hasAskQuestions(active.key)) {
        openAskGuard({ kind: "mode", mode });
        return;
      }
      slots.setSlotMode(active.key, mode);
      saveTutorMode(mode);
      setView("chat");
    },
    [slots, modesSupported, hasAskQuestions, openAskGuard],
  );

  const startNewSession = useCallback(() => {
    const active = slots.activeSlot;
    if (!active) return;
    if (active.mode === "ask" && hasAskQuestions(active.key)) {
      openAskGuard({ kind: "new" });
      return;
    }
    slots.resetSlot(active.key);
    setView("chat");
  }, [slots, hasAskQuestions, openAskGuard]);

  const selectConversation = useCallback(
    (conversation: ConversationSummary) => {
      const scope = conversation.scope;
      if (scope.kind === "library" ? !status?.scopes.library : !status?.scopes.book) return;
      const active = slots.activeSlot;
      if (active?.mode === "ask" && hasAskQuestions(active.key)) {
        openAskGuard({ kind: "select", conversation });
        return;
      }
      if (scope.kind === "library") slots.ensureLibrarySlot();
      if (!slots.selectConversation(conversation)) return;
      setView("chat");
      setOpen(true);
    },
    [status, slots, hasAskQuestions, openAskGuard],
  );

  const applyIntent = useCallback(
    (slotKey: string, intent: AskIntent) => {
      if (intent.kind === "mode") {
        slots.setSlotMode(slotKey, intent.mode);
        saveTutorMode(intent.mode);
        return;
      }
      if (intent.kind === "scope") {
        switchScope(intent.scope);
        return;
      }
      if (intent.kind === "select") {
        slots.selectConversation(intent.conversation);
        setView("chat");
        setOpen(true);
        return;
      }
      // "new" already reset the slot; show the fresh chat.
      setView("chat");
    },
    [slots, switchScope],
  );

  const discardAsk = useCallback(() => {
    const pending = pendingAsk;
    if (!pending) return;
    setPendingAsk(null);
    setSaveAskError("");
    slots.resetSlot(pending.slotKey);
    applyIntent(pending.slotKey, pending.intent);
  }, [pendingAsk, slots, applyIntent]);

  const cancelAsk = useCallback(() => {
    setPendingAsk(null);
    setSaveAskError("");
  }, []);

  const saveAsk = useCallback(async (keepLast = false) => {
    const pending = pendingAsk;
    if (!pending || savingAsk) return;
    const plan = planAskImport(pending.messages);
    if (plan.oversized) {
      setSaveAskError("A message in this chat is too long for a session, so nothing was saved.");
      return;
    }
    if (plan.malformed) {
      setSaveAskError(
        "This chat is not a question-and-answer sequence, so nothing was saved.",
      );
      return;
    }
    if (keepLast) {
      if (!plan.overLimit || plan.lastMessages.length < 2) {
        setSaveAskError("There are no complete messages to save in this chat.");
        return;
      }
    } else if (plan.overLimit) {
      setSaveAskError(
        `This chat has ${plan.transcriptMessages} messages. A session can save at most ${MAX_IMPORTED_MESSAGES} messages, so nothing was saved.`,
      );
      return;
    }
    const messages = keepLast ? plan.lastMessages : plan.messages;
    if (messages.length === 0) {
      setSaveAskError("Ask a question and get an answer before saving this chat.");
      return;
    }
    setSavingAsk(true);
    setSaveAskError("");
    const body: SaveConversationRequest = { scope: pending.scope, messages };
    try {
      const response = await api("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const summary = (await response.json()) as ConversationSummary;
      setPendingAsk(null);
      slots.setSlotMode(pending.slotKey, "session");
      slots.rememberConversation(pending.slotKey, summary);
      saveTutorMode("session");
      setView("chat");
      void chat?.refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The session could not be saved.";
      setSaveAskError(message);
      if (reason instanceof ApiError && reason.code === "conversation_limit") {
        const details = reason.details;
        limitStatusRef.current = status;
        setLimitHit({
          limit: typeof details?.limit === "number" ? details.limit : status?.sessionLimits?.maxSessions ?? 200,
          count: typeof details?.count === "number" ? details.count : status?.sessionLimits?.count ?? 0,
        });
      }
    } finally {
      setSavingAsk(false);
    }
  }, [api, pendingAsk, savingAsk, slots, chat, status]);

  const reportSessionLimit = useCallback(
    (details: ChatLimitDetails) => {
      limitStatusRef.current = status;
      setLimitHit({
        limit: details.limit ?? status?.sessionLimits?.maxSessions ?? 200,
        count: details.count ?? status?.sessionLimits?.count ?? 0,
      });
    },
    [status],
  );

  const clearSessionLimit = useCallback(() => {
    // The refreshed count decides: one delete may still leave the count at or above the limit.
    void chat?.refresh();
  }, [chat]);

  const refreshStatus = useCallback(() => {
    void chat?.refresh();
  }, [chat]);

  const setSlotUseLibrary = useCallback(
    (key: string, useLibrary: boolean) => {
      slots.setSlotUseLibrary(key, useLibrary);
      saveAskUseLibrary(useLibrary);
    },
    [slots],
  );

  const rememberConversation = useCallback(
    (key: string, summary: ConversationSummary) => {
      slots.rememberConversation(key, summary);
      void chat?.refresh();
    },
    [slots, chat],
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
    modesSupported,
    open,
    surface,
    view,
    reader,
    slots: slots.slots,
    activeKey: slots.activeKey,
    activeSlot: slots.activeSlot,
    revision: slots.revision,
    sessionLimit,
    openTutor,
    closeTutor,
    toggleTutor,
    setView,
    setMode,
    setChatMode,
    setSlotMode: slots.setSlotMode,
    setSlotUseLibrary,
    startNewSession,
    reportSessionLimit,
    clearSessionLimit,
    refreshStatus,
    registerTranscript,
    askAbout,
    useVisibleText,
    clearExcerpt: slots.clearExcerpt,
    selectConversation,
    rememberConversation,
    resumeSession: slots.resumeSession,
    markResumeChecked: slots.markResumeChecked,
    renameConversation: slots.renameConversation,
    setSlotStreaming: slots.setSlotStreaming,
    resetSlot: slots.resetSlot,
    forgetConversation: slots.forgetConversation,
    isConversationStreaming: slots.isConversationStreaming,
    registerReaderContext,
  };
  const askPlan = pendingAsk ? planAskImport(pendingAsk.messages) : null;
  return (
    <>
      <TutorContext.Provider value={value}>{children}</TutorContext.Provider>
      {pendingAsk && askPlan && (
        <SaveAskDialog
          scopeLabel={pendingAsk.scope.kind === "book" ? "this book" : "your library"}
          questionCount={pendingAsk.messages.filter((message) => message.role === "user").length}
          messageCount={askPlan.transcriptMessages}
          maxMessages={MAX_IMPORTED_MESSAGES}
          overLimit={askPlan.overLimit}
          oversized={askPlan.oversized}
          malformed={askPlan.malformed}
          incompleteAnswers={askPlan.incompleteAnswers}
          unansweredQuestions={askPlan.unansweredQuestions}
          lastMessageCount={askPlan.lastMessages.length}
          droppedMessages={askPlan.droppedMessages}
          canSave={askPlan.canSave}
          saving={savingAsk}
          error={saveAskError}
          onSave={() => void saveAsk(false)}
          onSaveLast={() => void saveAsk(true)}
          onDiscard={discardAsk}
          onCancel={cancelAsk}
        />
      )}
    </>
  );
}
