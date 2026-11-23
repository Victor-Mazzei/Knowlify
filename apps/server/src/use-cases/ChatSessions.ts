import {
  conversationTitle,
  normalizeImportedMessages,
  normalizeTitle,
  MAX_MESSAGES_PER_CONVERSATION,
  type ChatMessage,
  type ChatScope,
  type Conversation,
} from "../domain/assistant/Conversation.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import type { ConversationRepository } from "../ports/assistant.js";
import type { BookRepository, Clock, IdGenerator } from "../ports/index.js";

export const DEFAULT_SESSION_LIST_LIMIT = 20;
export const MAX_SESSION_LIST_LIMIT = 200;

export interface ChatSessionsLimits {
  maxConversations: number;
}

export interface ChatSessionImportInput {
  scope: unknown;
  title?: unknown;
  messages: unknown;
}

export interface ChatSessionDetail {
  conversation: Conversation;
  messages: ChatMessage[];
}

/**
 * Saved Sessions (ADR-1/ADR-9/ADR-13): listing, resume, rename and the "Save as
 * session" import. Ask turns never reach this use case, so they leave no row behind.
 */
export class ChatSessions {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly books: BookRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly limits: () => ChatSessionsLimits,
  ) {}

  list(input: { bookId?: string; limit?: number } = {}): Conversation[] {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_SESSION_LIST_LIMIT) || DEFAULT_SESSION_LIST_LIMIT, 1), MAX_SESSION_LIST_LIMIT);
    const scope: ChatScope = input.bookId ? { kind: "book", bookId: input.bookId } : { kind: "library" };
    return this.conversations.list(scope, limit);
  }

  get(id: string): ChatSessionDetail | undefined {
    const conversation = this.conversations.get(id);
    if (!conversation) return undefined;
    return { conversation, messages: this.conversations.messages(id) };
  }

  remove(id: string): boolean {
    return this.conversations.delete(id);
  }

  rename(id: string, rawTitle: unknown): Conversation | undefined {
    const title = normalizeTitle(rawTitle);
    return this.conversations.rename(id, title);
  }

  import(input: ChatSessionImportInput): Conversation {
    const scope = normalizeImportScope(input.scope);
    if (scope.kind === "book" && !this.books.get(scope.bookId)) throw new NotFoundError("Book not found");
    const messages = normalizeImportedMessages(
      input.messages,
      (bookId) => this.books.get(bookId)?.title,
    );
    const title = input.title === undefined
      ? conversationTitle(messages[0]?.content ?? "")
      : normalizeTitle(input.title);
    const now = this.clock.now();
    const conversation: Conversation = {
      id: this.ids.next(),
      scope,
      title,
      createdAt: now,
      updatedAt: now,
    };
    const stored: ChatMessage[] = messages.map((message) => ({
      id: this.ids.next(),
      role: message.role,
      content: message.content,
      citations: message.citations,
      promptVersion: null,
      createdAt: now,
    }));
    this.conversations.importSession(
      conversation,
      stored,
      {
        maxConversations: this.limits().maxConversations,
        maxMessagesPerConversation: MAX_MESSAGES_PER_CONVERSATION,
      },
      now,
    );
    return { ...conversation, messageCount: stored.length };
  }
}

function normalizeImportScope(raw: unknown): ChatScope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("scope must be {kind:\"library\"} or {kind:\"book\", bookId}");
  }
  const scope = raw as Record<string, unknown>;
  const keys = Object.keys(scope);
  if (scope.kind === "library" && keys.length === 1) return { kind: "library" };
  if (
    scope.kind === "book"
    && typeof scope.bookId === "string"
    && scope.bookId.length > 0
    && keys.length === 2
  ) {
    return { kind: "book", bookId: scope.bookId };
  }
  throw new ValidationError("scope must be {kind:\"library\"} or {kind:\"book\", bookId}");
}
