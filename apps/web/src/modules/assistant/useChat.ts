import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { ChatExcerpt } from "./excerpt";
import { withExcerpt } from "./excerpt";
import { createSseParser, parseChatEvent } from "./sse";
import type {
  ChatMessage,
  ChatRequest,
  ChatRequestScope,
  ChatScope,
  ConversationDetail,
  ConversationSummary,
} from "./types";

let nextLocalId = 0;
const localId = () => `local-${++nextLocalId}`;

const toChatScope = (scope: ChatRequestScope): ChatScope =>
  scope.kind === "book" ? { kind: "book", bookId: scope.bookId } : { kind: "library" };

/**
 * Owns one conversation: history, the live SSE turn, cancellation and retry.
 * The API function comes from `services/api`, so this hook never fetches directly.
 */
export function useChat({
  api,
  scope,
  initialConversationId,
  onConversation,
}: {
  api: ApiFn;
  scope: ChatRequestScope;
  initialConversationId?: string;
  onConversation?: (summary: ConversationSummary) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(Boolean(initialConversationId));
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);

  const conversationRef = useRef(initialConversationId);
  const controllerRef = useRef<AbortController>();
  const draftRef = useRef<string>();
  const alive = useRef(true);
  const scopeRef = useRef(scope);
  const apiRef = useRef(api);
  const onConversationRef = useRef(onConversation);
  const lastTurn = useRef<{ message: string; excerpt?: ChatExcerpt }>();
  scopeRef.current = scope;
  apiRef.current = api;
  onConversationRef.current = onConversation;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controllerRef.current?.abort();
      controllerRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!initialConversationId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setStopped(false);
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
  }, [api, initialConversationId]);

  const run = useCallback(async (text: string, excerpt: ChatExcerpt | undefined, appendUser: boolean) => {
    const message = text.trim().slice(0, 2000);
    if (!message || controllerRef.current) return;

    setError("");
    setStopped(false);
    setStreaming(true);
    lastTurn.current = { message, excerpt };

    const draftId = localId();
    draftRef.current = draftId;
    setMessages((previous) => {
      let end = previous.length;
      while (end > 0 && previous[end - 1]?.role === "assistant" && previous[end - 1]?.id.startsWith("local-")) end--;
      const history = previous.slice(0, end);
      const draft: ChatMessage = { id: draftId, role: "assistant", content: "", citations: null, createdAt: Date.now() };
      if (!appendUser) return [...history, draft];
      const question: ChatMessage = { id: localId(), role: "user", content: message, citations: null, createdAt: Date.now() };
      return [...history, question, draft];
    });

    const abort = new AbortController();
    controllerRef.current = abort;
    const body: ChatRequest = { message, scope: withExcerpt(scopeRef.current, excerpt) };
    if (conversationRef.current) body.conversationId = conversationRef.current;

    let completed = false;
    let failed = false;
    try {
      const response = await apiRef.current("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!response.body) throw new Error("This browser cannot stream the answer. Try again.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser((raw) => {
        if (abort.signal.aborted) return;
        const event = parseChatEvent(raw.data);
        if (!event) return;
        if (event.type === "sources") {
          // `sources` carries a provisional id: the server only persists a new
          // conversation with `done`. Adopting it here would make Retry or the next
          // question target a conversation that does not exist yet (404).
          setMessages((current) => current.map((item) => (item.id === draftId ? { ...item, citations: event.citations } : item)));
        } else if (event.type === "delta") {
          setMessages((current) => current.map((item) => (item.id === draftId ? { ...item, content: item.content + event.text } : item)));
        } else if (event.type === "done") {
          completed = true;
          conversationRef.current = event.conversationId;
          setConversationId(event.conversationId);
          onConversationRef.current?.({
            id: event.conversationId,
            title: event.title,
            scope: toChatScope(scopeRef.current),
            updatedAt: Date.now(),
          });
        } else {
          failed = true;
          setMessages((current) => current.filter((item) => item.id !== draftId));
          setError(event.message || "The answer could not be completed.");
        }
      });

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!alive.current) return;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      if (alive.current) {
        parser.feed(decoder.decode());
        parser.flush();
        if (!completed && !failed && !abort.signal.aborted) {
          setMessages((current) => current.filter((item) => item.id !== draftId));
          setError("The connection closed before the answer finished. Try again.");
        }
      }
    } catch (value) {
      if (!alive.current) return;
      if (!abort.signal.aborted) {
        setMessages((current) => current.filter((item) => item.id !== draftId));
        setError(formatError(value));
      }
    } finally {
      if (controllerRef.current === abort) controllerRef.current = undefined;
      if (draftRef.current === draftId) draftRef.current = undefined;
      if (alive.current) {
        setStreaming(false);
        if (completed) setStopped(false);
      }
    }
  }, []);

  const send = useCallback(
    (message: string, excerpt?: ChatExcerpt) => {
      if (controllerRef.current) return;
      void run(message, excerpt, true);
    },
    [run],
  );

  const stop = useCallback(() => {
    const abort = controllerRef.current;
    if (!abort) return;
    const draftId = draftRef.current;
    abort.abort();
    controllerRef.current = undefined;
    draftRef.current = undefined;
    setStreaming(false);
    setStopped(true);
    if (!draftId) return;
    setMessages((current) => {
      const draft = current.find((item) => item.id === draftId);
      return draft && !draft.content.trim() ? current.filter((item) => item.id !== draftId) : current;
    });
  }, []);

  const retry = useCallback(() => {
    const last = lastTurn.current;
    if (!last || controllerRef.current) return;
    setError("");
    setStopped(false);
    void run(last.message, last.excerpt, false);
  }, [run]);

  const canRetry = Boolean(!streaming && (error || stopped) && lastTurn.current);

  return { messages, conversationId, streaming, loading, error, stopped, canRetry, send, stop, retry };
}
