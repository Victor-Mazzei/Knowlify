import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { eventStream } from "./mockStream";
import type {
  ChatEvent,
  ChatMessage,
  ChatRequestScope,
  ChatScope,
  Citation,
  ConversationDetail,
  ConversationSummary,
} from "./types";

export type MockChatScenario = "answer" | "no-passages" | "timeout" | "rate-limited";

export type MockChatOptions = {
  enabled?: boolean;
  host?: string | null;
  scenario?: MockChatScenario;
  chunkDelayMs?: number;
  /** Seed one conversation so the rail is not empty while developing the UI. */
  seed?: boolean;
};

type StoredConversation = ConversationDetail & { updatedAt: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** `useApi` throws on non-2xx, so the mock does the same instead of returning an error Response. */
function fail(status: number, body: { message: string }): never {
  throw new ApiError(status, body.message);
}

const SEED_CITATIONS: Citation[] = [
  { n: 1, passageId: 1, bookId: "mock-book", bookTitle: "The Art of Memory", page: 42, section: "Chapter 3" },
  { n: 2, passageId: 2, bookId: "mock-book", bookTitle: "The Art of Memory", page: 58, section: "Chapter 4" },
];

const ANSWER =
  "Spaced repetition works by revisiting an idea just before you would forget it [1]. Instead of rereading, try to recall the answer first: the effort of retrieval is what strengthens memory [2].\n\nA useful first experiment: pick one chapter, write three questions from it, and answer them tomorrow without looking.";

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

function readRequest(value: unknown): { conversationId?: string; message: string; scope: ChatRequestScope } | null {
  if (!isRecord(value) || typeof value.message !== "string" || !value.message.trim()) return null;
  const scope = value.scope;
  if (!isRecord(scope)) return null;
  const conversationId = typeof value.conversationId === "string" ? value.conversationId : undefined;
  if (scope.kind === "library") return { conversationId, message: value.message, scope: { kind: "library" } };
  if (scope.kind !== "book" || typeof scope.bookId !== "string") return null;
  const excerpt = typeof scope.excerpt === "string" ? scope.excerpt : undefined;
  const excerptKind = scope.excerptKind === "selection" || scope.excerptKind === "visible" ? scope.excerptKind : undefined;
  const page = typeof scope.page === "number" ? scope.page : undefined;
  const section = typeof scope.section === "string" ? scope.section : undefined;
  return {
    conversationId,
    message: value.message,
    scope: {
      kind: "book",
      bookId: scope.bookId,
      ...(excerpt ? { excerpt } : {}),
      ...(excerptKind ? { excerptKind } : {}),
      ...(page ? { page } : {}),
      ...(section ? { section } : {}),
    },
  };
}

function seedConversation(): StoredConversation {
  const now = Date.now();
  return {
    id: "mock-1",
    title: "How does spaced repetition work?",
    scope: { kind: "library" },
    updatedAt: now - 60 * 60 * 1000,
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
  const conversations = new Map<string, StoredConversation>();
  let sequence = 0;

  if (options.seed !== false) {
    const seeded = seedConversation();
    conversations.set(seeded.id, seeded);
  }

  return async (path, init = {}) => {
    const url = new URL(path, "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    const detailMatch = /^\/api\/chat\/conversations\/([^/]+)$/.exec(url.pathname);

    if (url.pathname === "/api/chat/status" && method === "GET") {
      return json(200, {
        enabled,
        model: enabled ? "deepseek-v4.1-flash" : null,
        host: enabled ? host : null,
        promptVersion: "feynman-1",
        scopes: { library: enabled, book: enabled },
      });
    }

    if (url.pathname === "/api/chat/conversations" && method === "GET") {
      const bookId = url.searchParams.get("bookId");
      const requested = Number(url.searchParams.get("limit") ?? 20);
      const limit = Number.isFinite(requested) ? Math.min(50, Math.max(1, requested)) : 20;
      const list: ConversationSummary[] = [...conversations.values()]
        .filter((item) =>
          bookId ? item.scope.kind === "book" && item.scope.bookId === bookId : item.scope.kind === "library",
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map(({ id, title, scope, updatedAt }) => ({ id, title, scope, updatedAt }));
      return json(200, list);
    }

    if (detailMatch && method === "GET") {
      const conversation = conversations.get(decodeURIComponent(detailMatch[1] ?? ""));
      if (!conversation) fail(404, { message: "Conversation not found." });
      return json(200, {
        id: conversation.id,
        title: conversation.title,
        scope: conversation.scope,
        messages: conversation.messages,
      });
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

      const existing = request.conversationId ? conversations.get(request.conversationId) : undefined;
      if (request.conversationId && !existing) fail(404, { message: "Conversation not found." });
      if (existing && !sameScope(existing.scope, request.scope))
        fail(409, { message: "This conversation belongs to a different scope." });
      if (existing && existing.messages.length >= 100)
        fail(409, { message: "This conversation is full. Start a new one." });

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
        { type: "sources", conversationId: id, retrieval: citations.length ? "hybrid" : "none", citations },
      ];
      if (scenario === "timeout") {
        events.push({ type: "delta", text: "Let me think about that" });
        events.push({ type: "error", code: "llm_timeout", message: "The model took too long to answer. Try again." });
      } else {
        for (const text of chunkAnswer(answer)) events.push({ type: "delta", text });
        events.push({ type: "done", conversationId: id, messageId: assistant.id, title, finishReason: "stop" });
      }

      return eventStream(events, delayMs, init.signal, (event) => {
        if (event.type !== "done") return;
        const stored = conversations.get(id);
        if (stored) {
          stored.messages.push(user, assistant);
          stored.updatedAt = Date.now();
        } else {
          conversations.set(id, { id, title, scope: toChatScope(request.scope), updatedAt: Date.now(), messages: [user, assistant] });
        }
      });
    }

    fail(404, { message: "Mock chat route not found." });
  };
}

/** Module-level store so the header, the page and the reader share one mock conversation set. */
export const mockChatApi: ApiFn = createMockChatApi();
