import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, formatError } from "../../services/api";
import { openChatStream } from "./chatStream";
import type { ChatStream } from "./chatStream";
import type { ChatExcerpt } from "./excerpt";
import { withExcerpt } from "./excerpt";
import { createSseParser, parseChatEvent } from "./sse";
import type {
  ChatMessage,
  ChatMode,
  ChatRequest,
  ChatRequestScope,
  ChatScope,
  ConversationDetail,
  ConversationSummary,
} from "./types";

let nextLocalId = 0;
const localId = () => `local-${++nextLocalId}`;

/** Batches deltas so a token burst costs one render, not one per token. */
const DELTA_FLUSH_MS = 100;

const toChatScope = (scope: ChatRequestScope): ChatScope =>
  scope.kind === "book" ? { kind: "book", bookId: scope.bookId } : { kind: "library" };

export type ChatLimitDetails = { limit?: number; count?: number; message?: string };

/**
 * Owns one conversation: history, the live SSE turn, cancellation and retry.
 * Ask turns never load or keep a conversation id; Session turns persist.
 * The API function comes from `services/api`, so this hook never fetches directly.
 */
export function useChat({
  api,
  scope,
  initialConversationId,
  onConversation,
  mode = "session",
  useLibrary = true,
  modesSupported = false,
  onLimit,
  onFull,
}: {
  api: ApiFn;
  scope: ChatRequestScope;
  initialConversationId?: string;
  onConversation?: (summary: ConversationSummary) => void;
  mode?: ChatMode;
  /** Ask only: whether the turn may search the library. */
  useLibrary?: boolean;
  /** False on servers without `status.modes`: no `mode` or `useLibrary` is sent. */
  modesSupported?: boolean;
  onLimit?: (details: ChatLimitDetails) => void;
  onFull?: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(
    mode === "session" ? initialConversationId : undefined,
  );
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(Boolean(mode === "session" && initialConversationId));
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [limitError, setLimitError] = useState<ChatLimitDetails | null>(null);
  const [sessionFull, setSessionFull] = useState(false);

  const conversationRef = useRef(mode === "session" ? initialConversationId : undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const readerRef = useRef<ChatStream | undefined>(undefined);
  /** The empty assistant bubble the current run is streaming into. */
  const draftRef = useRef<string | undefined>(undefined);
  /** A partial answer kept after a failure; Retry replaces exactly this one. */
  const failedDraftRef = useRef<string | undefined>(undefined);
  const flushRef = useRef<(() => void) | undefined>(undefined);
  const cancelFlushRef = useRef<(() => void) | undefined>(undefined);
  /** The answer already reached `done` or a terminal error; Stop must not touch it. */
  const finishedRef = useRef(false);
  const alive = useRef(true);
  const scopeRef = useRef(scope);
  const apiRef = useRef(api);
  const modeRef = useRef(mode);
  const useLibraryRef = useRef(useLibrary);
  const onConversationRef = useRef(onConversation);
  const onLimitRef = useRef(onLimit);
  const onFullRef = useRef(onFull);
  const lastTurn = useRef<{ message: string; excerpt?: ChatExcerpt } | undefined>(undefined);
  scopeRef.current = scope;
  apiRef.current = api;
  modeRef.current = mode;
  useLibraryRef.current = useLibrary;
  onConversationRef.current = onConversation;
  onLimitRef.current = onLimit;
  onFullRef.current = onFull;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelFlushRef.current?.();
      void readerRef.current?.cancel().catch(() => undefined);
      controllerRef.current?.abort();
      controllerRef.current = undefined;
      readerRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!initialConversationId || mode !== "session") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setStopped(false);
    setSessionFull(false);
    api(`/api/chat/conversations/${encodeURIComponent(initialConversationId)}`)
      .then((response) => response.json() as Promise<ConversationDetail>)
      .then((detail) => {
        if (cancelled) return;
        setMessages(detail.messages);
        conversationRef.current = detail.id;
        setConversationId(detail.id);
      })
      .catch((value) => {
        if (cancelled) return;
        conversationRef.current = undefined;
        setConversationId(undefined);
        setError(formatError(value));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, initialConversationId, mode]);

  const run = useCallback(
    async (text: string, excerpt: ChatExcerpt | undefined, appendUser: boolean, replaceDraftId?: string) => {
      const message = text.trim().slice(0, 2000);
      if (!message || controllerRef.current) return;

      setError("");
      setStopped(false);
      setLimitError(null);
      setSessionFull(false);
      setStreaming(true);
      lastTurn.current = { message, excerpt };
      failedDraftRef.current = undefined;
      finishedRef.current = false;

      const draftId = localId();
      const questionId = appendUser ? localId() : undefined;
      draftRef.current = draftId;
      setMessages((previous) => {
        const history = replaceDraftId ? previous.filter((item) => item.id !== replaceDraftId) : previous;
        const draft: ChatMessage = { id: draftId, role: "assistant", content: "", citations: null, createdAt: Date.now() };
        if (!appendUser) return [...history, draft];
        const question: ChatMessage = {
          id: questionId!,
          role: "user",
          content: message,
          citations: null,
          createdAt: Date.now(),
        };
        return [...history, question, draft];
      });

      const abort = new AbortController();
      controllerRef.current = abort;
      const turnMode = modesSupported ? modeRef.current : "session";
      const body: ChatRequest = { message, scope: withExcerpt(scopeRef.current, excerpt) };
      if (modesSupported) {
        body.mode = turnMode;
        if (turnMode === "ask") body.useLibrary = useLibraryRef.current;
      }
      if (turnMode === "session" && conversationRef.current) body.conversationId = conversationRef.current;

      let completed = false;
      let failed = false;
      let streamed = "";
      let pending = "";
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let lastFlush = 0;

      const cancelFlush = () => {
        if (flushTimer === undefined) return;
        clearTimeout(flushTimer);
        flushTimer = undefined;
      };
      const flush = () => {
        cancelFlush();
        if (!pending || !alive.current) {
          pending = "";
          return;
        }
        const chunk = pending;
        pending = "";
        lastFlush = Date.now();
        setMessages((current) =>
          current.map((item) => (item.id === draftId ? { ...item, content: item.content + chunk } : item)),
        );
      };
      const queueDelta = (chunk: string) => {
        streamed += chunk;
        pending += chunk;
        const wait = DELTA_FLUSH_MS - (Date.now() - lastFlush);
        if (wait <= 0) flush();
        else if (flushTimer === undefined) flushTimer = setTimeout(flush, wait);
      };
      const keepPartial = (reason: string) => {
        if (streamed.trim()) {
          failedDraftRef.current = draftId;
          setMessages((current) =>
            current.map((item) => (item.id === draftId ? { ...item, incomplete: true } : item)),
          );
        } else {
          setMessages((current) => current.filter((item) => item.id !== draftId));
        }
        setError(reason);
      };
      /** The turn never reached the server: keep the question in the composer, not the transcript. */
      const restoreQuestion = () => {
        setMessages((current) =>
          current.filter((item) => item.id !== draftId && item.id !== questionId),
        );
      };
      flushRef.current = flush;
      cancelFlushRef.current = cancelFlush;

      let reader: ChatStream | undefined;
      try {
        reader = await openChatStream(apiRef.current, "/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        readerRef.current = reader;
        const parser = createSseParser((raw) => {
          if (abort.signal.aborted || completed || failed) return;
          const event = parseChatEvent(raw.data);
          if (!event) return;
          if (event.type === "sources") {
            // Ask without the library never shows citations, even if a server sent them.
            const citations = turnMode === "ask" && !useLibraryRef.current ? [] : event.citations;
            setMessages((current) =>
              current.map((item) => (item.id === draftId ? { ...item, citations } : item)),
            );
          } else if (event.type === "delta") {
            queueDelta(event.text);
          } else if (event.type === "done") {
            flush();
            completed = true;
            finishedRef.current = true;
            const persisted =
              turnMode === "session" && event.persisted !== false && typeof event.conversationId === "string";
            if (persisted) {
              conversationRef.current = event.conversationId!;
              setConversationId(event.conversationId!);
            }
            setMessages((current) =>
              current.map((item) =>
                item.id === draftId ? { ...item, id: event.messageId, incomplete: false } : item,
              ),
            );
            if (persisted) {
              onConversationRef.current?.({
                id: event.conversationId!,
                title: event.title,
                scope: toChatScope(scopeRef.current),
                updatedAt: Date.now(),
                persisted: true,
              });
            }
          } else {
            failed = true;
            finishedRef.current = true;
            flush();
            keepPartial(event.message || "The answer could not be completed.");
          }
        });

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!alive.current) return;
          if (value) parser.feed(value);
        }
        if (alive.current) {
          parser.flush();
          if (!completed && !failed && !abort.signal.aborted) {
            finishedRef.current = true;
            flush();
            keepPartial("The connection closed before the answer finished. Try again.");
          }
        }
      } catch (value) {
        if (!alive.current || abort.signal.aborted) return;
        finishedRef.current = true;
        flush();
        if (value instanceof ApiError && value.code === "conversation_limit") {
          restoreQuestion();
          const limit = typeof value.details?.limit === "number" ? value.details.limit : undefined;
          const count = typeof value.details?.count === "number" ? value.details.count : undefined;
          const details = { limit, count, message: value.message };
          setLimitError(details);
          onLimitRef.current?.(details);
          return;
        }
        if (value instanceof ApiError && value.code === "conversation_full") {
          restoreQuestion();
          setSessionFull(true);
          onFullRef.current?.("This session is full. Start a new session.");
          return;
        }
        keepPartial(formatError(value));
      } finally {
        cancelFlush();
        if (cancelFlushRef.current === cancelFlush) cancelFlushRef.current = undefined;
        if (flushRef.current === flush) flushRef.current = undefined;
        if (controllerRef.current === abort) controllerRef.current = undefined;
        if (readerRef.current === reader) readerRef.current = undefined;
        if (draftRef.current === draftId) draftRef.current = undefined;
        if (alive.current) {
          setStreaming(false);
          if (completed) setStopped(false);
        }
      }
    },
    [modesSupported],
  );

  const send = useCallback(
    (message: string, excerpt?: ChatExcerpt) => {
      if (controllerRef.current) return;
      void run(message, excerpt, true);
    },
    [run],
  );

  const stop = useCallback(() => {
    const abort = controllerRef.current;
    if (!abort || finishedRef.current) return;
    const draftId = draftRef.current;
    flushRef.current?.();
    // Cancel the reader before aborting: aborting first errors the stream and the
    // underlying source's cancel hook never runs.
    void readerRef.current?.cancel().catch(() => undefined);
    abort.abort();
    setStopped(true);
    if (!draftId) return;
    // Retry replaces this draft; the stream's `finally` releases the next send.
    failedDraftRef.current = draftId;
    setMessages((current) => {
      const draft = current.find((item) => item.id === draftId);
      if (!draft) return current;
      if (!draft.content.trim()) return current.filter((item) => item.id !== draftId);
      return current.map((item) => (item.id === draftId ? { ...item, incomplete: true } : item));
    });
  }, []);

  const retry = useCallback(() => {
    const last = lastTurn.current;
    if (!last || controllerRef.current) return;
    const replace = failedDraftRef.current;
    failedDraftRef.current = undefined;
    setError("");
    setStopped(false);
    setSessionFull(false);
    void run(last.message, last.excerpt, false, replace);
  }, [run]);

  const canRetry = Boolean(!streaming && (error || stopped) && lastTurn.current && !sessionFull);

  return {
    messages,
    conversationId,
    streaming,
    loading,
    error,
    stopped,
    canRetry,
    limitError,
    sessionFull,
    send,
    stop,
    retry,
  };
}
