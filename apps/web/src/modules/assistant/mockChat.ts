import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { eventStream } from "./mockStream";
import type {
  ChatEvent,
  ChatMessage,
  ChatMode,
  ChatRequestScope,
  ChatScope,
  Citation,
  ConversationDetail,
  ConversationSummary,
  ImportedMessage,
} from "./types";

export type MockChatScenario = "answer" | "no-passages" | "timeout" | "rate-limited";

export type MockChatOptions = {
  enabled?: boolean;
  host?: string | null;
  scenario?: MockChatScenario;
  chunkDelayMs?: number;
  /** Seed one conversation so the rail is not empty while developing the UI. */
  seed?: boolean;
  /** Set to false to emulate an older server that only knows Session. */
  modes?: boolean;
  /** Blocking session limit; defaults to 200 like the server. */
  maxSessions?: number;
};

type StoredConversation = ConversationDetail & { updatedAt: number; createdAt: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** `useApi` throws on non-2xx, so the mock does the same instead of returning an error Response. */
function fail(status: number, body: Record<string, unknown> & { message: string }): never {
  throw new ApiError(status, body.message, typeof body.code === "string" ? body.code : undefined, body);
}

const SEED_CITATIONS: Citation[] = [
  { n: 1, passageId: 1, bookId: "mock-book", bookTitle: "The Art of Memory", page: 42, section: "Chapter 3" },
  { n: 2, passageId: 2, bookId: "mock-book", bookTitle: "The Art of Memory", page: 58, section: "Chapter 4" },
];

const ANSWER =
  "Spaced repetition works by revisiting an idea just before you would forget it [1]. Instead of rereading, try to recall the answer first: the effort of retrieval is what strengthens memory [2].\n\nA useful first experiment: pick one chapter, write three questions from it, and answer them tomorrow without looking.";

const ANSWER_NO_LIBRARY =
  "Spaced repetition works by revisiting an idea just before you would forget it. Instead of rereading, try to recall the answer first: the effort of retrieval is what strengthens memory.\n\nA useful first experiment: pick one chapter, write three questions from it, and answer them tomorrow without looking.";

const NO_PASSAGES = "I couldn't find passages about this in your library yet.";

const chunkAnswer = (text: string, wordsPerChunk = 9) => {
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let current = "";
  let count = 0;
  for (const word of words) {
    current += word;
    if (word.trim()) count++;
    if (count >= wordsPerChunk) {
      chunks.push(current);
      current = "";
      count = 0;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};

const toChatScope = (scope: ChatRequestScope): ChatScope =>
  scope.kind === "book" ? { kind: "book", bookId: scope.bookId } : { kind: "library" };

const sameScope = (a: ChatScope, b: ChatScope) =>
  a.kind === "book" ? b.kind === "book" && a.bookId === b.bookId : b.kind === "library";

const readScope = (value: unknown): ChatScope | null => {
  if (!isRecord(value)) return null;
  if (value.kind === "library") return { kind: "library" };
  if (value.kind === "book" && typeof value.bookId === "string" && value.bookId)
    return { kind: "book", bookId: value.bookId };
  return null;
};

const readRequest = (
  value: unknown,
): { conversationId?: string; message: string; scope: ChatRequestScope; mode?: ChatMode; useLibrary?: boolean } | null => {
  if (!isRecord(value) || typeof value.message !== "string" || !value.message.trim()) return null;
  const scope = value.scope;
  if (!isRecord(scope)) return null;
  const conversationId = typeof value.conversationId === "string" ? value.conversationId : undefined;
  const mode = value.mode === "ask" || value.mode === "session" ? value.mode : undefined;
  const useLibrary = typeof value.useLibrary === "boolean" ? value.useLibrary : undefined;
  if (scope.kind === "library")
    return { conversationId, message: value.message, scope: { kind: "library" }, mode, useLibrary };
  if (scope.kind !== "book" || typeof scope.bookId !== "string") return null;
  const excerpt = typeof scope.excerpt === "string" ? scope.excerpt : undefined;
  const excerptKind = scope.excerptKind === "selection" || scope.excerptKind === "visible" ? scope.excerptKind : undefined;
  const page = typeof scope.page === "number" ? scope.page : undefined;
  const section = typeof scope.section === "string" ? scope.section : undefined;
  return {
    conversationId,
    message: value.message,
    mode,
    useLibrary,
    scope: {
      kind: "book",
      bookId: scope.bookId,
      ...(excerpt ? { excerpt } : {}),
      ...(excerptKind ? { excerptKind } : {}),
      ...(page ? { page } : {}),
      ...(section ? { section } : {}),
    },
  };
};

const isCitation = (value: unknown): value is Citation =>
  isRecord(value) &&
  typeof value.n === "number" &&
  typeof value.passageId === "number" &&
  typeof value.bookId === "string" &&
  typeof value.bookTitle === "string" &&
  (value.page === null || typeof value.page === "number") &&
  (value.section === null || typeof value.section === "string");

const readImportedMessages = (value: unknown): ImportedMessage[] | null => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) return null;
  const messages: ImportedMessage[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.content !== "string") return null;
    const role = index % 2 === 0 ? "user" : "assistant";
    if (item.role !== role) return null;
    const max = role === "user" ? 2000 : 8000;
    if (!item.content.trim() || item.content.length > max) return null;
    const citations = item.citations;
    if (citations !== undefined && (!Array.isArray(citations) || !citations.every(isCitation))) return null;
    messages.push({
      role,
      content: item.content,
      ...(citations ? { citations } : {}),
    });
  }
  return messages;
};

const summaryOf = (conversation: StoredConversation): ConversationSummary => ({
  id: conversation.id,
  title: conversation.title,
  scope: conversation.scope,
  updatedAt: conversation.updatedAt,
  createdAt: conversation.createdAt,
  messageCount: conversation.messages.length,
  persisted: true,
});

function seedConversation(): StoredConversation {
  const now = Date.now();
  return {
    id: "mock-1",
    title: "How does spaced repetition work?",
    scope: { kind: "library" },
    updatedAt: now - 60 * 60 * 1000,
    createdAt: now - 2 * 60 * 60 * 1000,
    messages: [
      { id: "mock-user-1", role: "user", content: "How does spaced repetition work?", citations: null, createdAt: now - 2 * 60 * 60 * 1000 },
      {
        id: "mock-assistant-1",
        role: "assistant",
        content: ANSWER,
        citations: SEED_CITATIONS,
        createdAt: now - 2 * 60 * 60 * 1000 + 1000,
      },
    ],
  };
}

/** In-memory stand-in for `/api/chat/*`, used by tests and by `VITE_MOCK_CHAT=1` in dev. */
export function createMockChatApi(options: MockChatOptions = {}): ApiFn {
  const enabled = options.enabled ?? true;
  const host = options.host === undefined ? "api.deepseek.com" : options.host;
  const scenario = options.scenario ?? "answer";
  const delayMs = options.chunkDelayMs ?? 18;
  const modesSupported = options.modes ?? true;
  const maxSessions = options.maxSessions ?? 200;
  const conversations = new Map<string, StoredConversation>();
  let sequence = 0;

  if (options.seed !== false) {
    const seeded = seedConversation();
    conversations.set(seeded.id, seeded);
  }

  const limitError = () =>
    fail(409, {
      message: `You have ${conversations.size} sessions; the limit is ${maxSessions}. Delete a session or raise the limit to start a new one.`,
      code: "conversation_limit",
      limit: maxSessions,
      count: conversations.size,
    });

  return async (path, init = {}) => {
    const url = new URL(path, "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    const detailMatch = /^\/api\/chat\/conversations\/([^/]+)$/.exec(url.pathname);

    if (url.pathname === "/api/chat/status" && method === "GET") {
      return json(200, {
        enabled,
        model: enabled ? "deepseek-v4.1-flash" : null,
        host: enabled ? host : null,
        promptVersion: "feynman-4",
        scopes: { library: enabled, book: enabled },
        ...(modesSupported ? { modes: ["ask", "session"] } : {}),
        ...(modesSupported
          ? { sessionLimits: { maxSessions, count: conversations.size, maxMessages: 100 } }
          : {}),
      });
    }

    if (url.pathname === "/api/chat/conversations" && method === "GET") {
      const bookId = url.searchParams.get("bookId");
      const requested = Number(url.searchParams.get("limit") ?? 20);
      const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, requested)) : 20;
      const list: ConversationSummary[] = [...conversations.values()]
        .filter((item) =>
          bookId ? item.scope.kind === "book" && item.scope.bookId === bookId : item.scope.kind === "library",
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map(summaryOf);
      return json(200, list);
    }

    if (url.pathname === "/api/chat/conversations" && method === "POST") {
      if (conversations.size >= maxSessions) limitError();
      let payload: unknown;
      try {
        payload = JSON.parse(typeof init.body === "string" ? init.body : "");
      } catch {
        fail(400, { message: "The session could not be read." });
      }
      if (!isRecord(payload)) fail(400, { message: "The session could not be read." });
      const scope = readScope(payload.scope);
      const messages = readImportedMessages(payload.messages);
      if (!scope || !messages) fail(400, { message: "The session could not be read." });
      const rawTitle = typeof payload.title === "string" ? payload.title.trim() : "";
      if (rawTitle.length > 80) fail(400, { message: "Use a title of 1 to 80 characters." });
      if (payload.title !== undefined && !rawTitle)
        fail(400, { message: "Use a title of 1 to 80 characters." });
      const now = Date.now();
      const id = `mock-conv-${++sequence}`;
      const firstQuestion = messages.find((message) => message.role === "user")?.content ?? "Session";
      const title = rawTitle || firstQuestion.trim().slice(0, 80);
      const stored: StoredConversation = {
        id,
        title,
        scope,
        updatedAt: now,
        createdAt: now,
        messages: messages.map((message, index) => ({
          id: `mock-msg-${++sequence}`,
          role: message.role,
          content: message.content,
          citations: message.citations?.length ? message.citations : null,
          createdAt: now + index,
        })),
      };
      conversations.set(id, stored);
      return json(201, summaryOf(stored));
    }

    if (detailMatch && method === "GET") {
      const conversation = conversations.get(decodeURIComponent(detailMatch[1] ?? ""));
      if (!conversation) fail(404, { message: "Conversation not found." });
      return json(200, {
        id: conversation.id,
        title: conversation.title,
        scope: conversation.scope,
        createdAt: conversation.createdAt,
        messageCount: conversation.messages.length,
        messages: conversation.messages,
      });
    }

    if (detailMatch && method === "PATCH") {
      const conversation = conversations.get(decodeURIComponent(detailMatch[1] ?? ""));
      if (!conversation) fail(404, { message: "Conversation not found." });
      let payload: unknown;
      try {
        payload = JSON.parse(typeof init.body === "string" ? init.body : "");
      } catch {
        fail(400, { message: "Use a title of 1 to 80 characters." });
      }
      if (!isRecord(payload) || typeof payload.title !== "string")
        fail(400, { message: "Use a title of 1 to 80 characters." });
      const title = payload.title.trim();
      if (!title || title.length > 80) fail(400, { message: "Use a title of 1 to 80 characters." });
      conversation.title = title;
      return json(200, summaryOf(conversation));
    }

    if (detailMatch && method === "DELETE") {
      const removed = conversations.delete(decodeURIComponent(detailMatch[1] ?? ""));
      if (!removed) fail(404, { message: "Conversation not found." });
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/chat/messages" && method === "POST") {
      if (!enabled) fail(503, { message: "Chat is not configured." });
      if (scenario === "rate-limited") fail(429, { message: "Too many messages. Try again in a minute." });
      let payload: unknown;
      try {
        payload = JSON.parse(typeof init.body === "string" ? init.body : "");
      } catch {
        fail(400, { message: "The question could not be read." });
      }
      const request = readRequest(payload);
      if (!request) fail(400, { message: "The question could not be read." });

      const mode = request.mode ?? "session";
      if (!modesSupported && request.mode !== undefined)
        fail(400, { message: "This server does not support chat modes.", code: "invalid_mode" });
      if (request.mode === "ask" && request.conversationId)
        fail(400, { message: "Ask does not keep a conversation.", code: "invalid_mode" });
      if (request.useLibrary !== undefined && (request.mode ?? "session") !== "ask")
        fail(400, { message: "Sessions always use the library.", code: "invalid_mode" });

      if (mode === "ask") {
        const useLibrary = request.useLibrary !== false;
        const citations = useLibrary && scenario !== "no-passages" ? SEED_CITATIONS : [];
        const answer =
          scenario === "no-passages" && useLibrary
            ? NO_PASSAGES
            : useLibrary
              ? ANSWER
              : ANSWER_NO_LIBRARY;
        const now = Date.now();
        const messageId = `mock-msg-${++sequence}`;
        const events: ChatEvent[] = [
          {
            type: "sources",
            conversationId: null,
            retrieval: citations.length ? "hybrid" : "none",
            citations,
            mode: "ask",
            persisted: false,
            useLibrary,
          },
        ];
        if (scenario === "timeout") {
          events.push({ type: "delta", text: "Let me think about that" });
          events.push({ type: "error", code: "llm_timeout", message: "The model took too long to answer. Try again." });
        } else {
          for (const text of chunkAnswer(answer)) events.push({ type: "delta", text });
          events.push({
            type: "done",
            conversationId: null,
            messageId,
            title: "",
            finishReason: "stop",
            mode: "ask",
            persisted: false,
          });
        }
        return eventStream(events, delayMs, init.signal);
      }

      const existing = request.conversationId ? conversations.get(request.conversationId) : undefined;
      if (request.conversationId && !existing) fail(404, { message: "Conversation not found." });
      if (existing && !sameScope(existing.scope, request.scope))
        fail(409, { message: "This conversation belongs to a different scope." });
      if (existing && existing.messages.length >= 100)
        fail(409, { message: "This conversation is full. Start a new one.", code: "conversation_full" });
      if (!existing && conversations.size >= maxSessions) limitError();

      const id = existing?.id ?? `mock-conv-${++sequence}`;
      const title = existing?.title ?? request.message.trim().slice(0, 80);
      const citations = scenario === "no-passages" ? [] : SEED_CITATIONS;
      const answer = scenario === "no-passages" ? NO_PASSAGES : ANSWER;
      const now = Date.now();
      const user: ChatMessage = { id: `mock-msg-${++sequence}`, role: "user", content: request.message, citations: null, createdAt: now };
      const assistant: ChatMessage = {
        id: `mock-msg-${++sequence}`,
        role: "assistant",
        content: answer,
        citations: citations.length ? citations : null,
        createdAt: now + 1,
      };
      const events: ChatEvent[] = [
        {
          type: "sources",
          conversationId: id,
          retrieval: citations.length ? "hybrid" : "none",
          citations,
          mode: "session",
          persisted: true,
        },
      ];
      if (scenario === "timeout") {
        events.push({ type: "delta", text: "Let me think about that" });
        events.push({ type: "error", code: "llm_timeout", message: "The model took too long to answer. Try again." });
      } else {
        for (const text of chunkAnswer(answer)) events.push({ type: "delta", text });
        events.push({
          type: "done",
          conversationId: id,
          messageId: assistant.id,
          title,
          finishReason: "stop",
          mode: "session",
          persisted: true,
        });
      }

      return eventStream(events, delayMs, init.signal, (event) => {
        if (event.type !== "done") return;
        const stored = conversations.get(id);
        if (stored) {
          stored.messages.push(user, assistant);
          stored.updatedAt = Date.now();
        } else {
          conversations.set(id, {
            id,
            title,
            scope: toChatScope(request.scope),
            updatedAt: Date.now(),
            createdAt: Date.now(),
            messages: [user, assistant],
          });
        }
      });
    }

    fail(404, { message: "Mock chat route not found." });
  };
}

const devQuery =
  import.meta.env.DEV && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : undefined;
const devMaxSessions = Number(devQuery?.get("mockMaxSessions"));
const devModes = devQuery?.get("mockModes");

/** Module-level store so the header, the page and the reader share one mock conversation set. */
export const mockChatApi: ApiFn = createMockChatApi({
  ...(Number.isFinite(devMaxSessions) && devMaxSessions > 0 ? { maxSessions: devMaxSessions } : {}),
  ...(devModes === "0" ? { modes: false } : {}),
});
