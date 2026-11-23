import type { ChatMessage, ChatScope, Citation, Conversation } from "../../domain/assistant/Conversation.js";
import { ConversationFullError, ConversationLimitError } from "../../domain/assistant/errors.js";
import type { ConversationCaps, ConversationRepository, ConversationTurn } from "../../ports/assistant.js";
import type { Db } from "./db.js";

interface ConversationRow {
  id: string;
  scope_kind: "library" | "book";
  book_id: string | null;
  title: string;
  created_at: number;
  updated_at: number;
  message_count?: number;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  citations_json: string | null;
  prompt_version: string | null;
  created_at: number;
}

function toScope(row: ConversationRow): ChatScope {
  if (row.scope_kind === "book") {
    if (!row.book_id) throw new Error("Conversation row is missing its book");
    return { kind: "book", bookId: row.book_id };
  }
  return { kind: "library" };
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    scope: toScope(row),
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.message_count !== undefined ? { messageCount: row.message_count } : {}),
  };
}

function toRole(row: MessageRow): "user" | "assistant" {
  if (row.role === "user" || row.role === "assistant") return row.role;
  throw new Error("Unexpected message role");
}

function toCitations(value: string | null): Citation[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const citations: Citation[] = [];
  for (const entry of parsed) {
    const citation = toCitation(entry);
    if (!citation) return null;
    citations.push(citation);
  }
  return citations;
}

function toCitation(value: unknown): Citation | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.n !== "number" || typeof entry.passageId !== "number") return null;
  if (typeof entry.bookId !== "string" || typeof entry.bookTitle !== "string") return null;
  const page = entry.page === null ? null : typeof entry.page === "number" ? entry.page : undefined;
  const section = entry.section === null ? null : typeof entry.section === "string" ? entry.section : undefined;
  if (page === undefined || section === undefined) return null;
  return {
    n: entry.n,
    passageId: entry.passageId,
    bookId: entry.bookId,
    bookTitle: entry.bookTitle,
    page,
    section,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: toRole(row),
    content: row.content,
    citations: toCitations(row.citations_json),
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

/** SQLite store for the Assistant context. Writes that touch messages are transactional. */
export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: Db) {}

  create(conversation: Conversation): void {
    this.insertConversation(conversation);
  }

  get(id: string): Conversation | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
    return row ? toConversation(row) : undefined;
  }

  messages(conversationId: string): ChatMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq").all(conversationId) as MessageRow[];
    return rows.map(toMessage);
  }

  saveTurn(turn: ConversationTurn, caps: ConversationCaps, now: number): void {
    // `immediate` takes the write lock before the cap is read, so two processes cannot
    // both pass the check and create one session beyond the limit.
    this.db.transaction(() => {
      const exists = this.db.prepare("SELECT 1 AS present FROM conversations WHERE id = ?").get(turn.conversationId);
      if (turn.newConversation) {
        if (turn.newConversation.id !== turn.conversationId) {
          throw new Error("Conversation turn id does not match the new conversation");
        }
        if (exists) throw new Error("Conversation already exists");
        this.assertConversationLimit(caps);
        this.insertConversation(turn.newConversation);
      } else if (!exists) {
        throw new Error("Conversation does not exist");
      }

      const row = this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
        .get(turn.conversationId) as { count: number };
      if (row.count + 2 > caps.maxMessagesPerConversation) throw new ConversationFullError();

      const seq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?")
        .get(turn.conversationId) as { seq: number };
      const insert = this.messageInserter();
      insert.run({
        id: turn.user.id,
        conversation_id: turn.conversationId,
        seq: seq.seq + 1,
        role: turn.user.role,
        content: turn.user.content,
        citations_json: null,
        prompt_version: null,
        created_at: turn.user.createdAt,
      });
      insert.run({
        id: turn.assistant.id,
        conversation_id: turn.conversationId,
        seq: seq.seq + 2,
        role: turn.assistant.role,
        content: turn.assistant.content,
        citations_json: turn.assistant.citations ? JSON.stringify(turn.assistant.citations) : null,
        prompt_version: turn.assistant.promptVersion,
        created_at: turn.assistant.createdAt,
      });
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, turn.conversationId);
    }).immediate();
  }

  importSession(
    conversation: Conversation,
    messages: readonly ChatMessage[],
    caps: ConversationCaps,
    _now: number,
  ): void {
    this.db.transaction(() => {
      const exists = this.db.prepare("SELECT 1 AS present FROM conversations WHERE id = ?").get(conversation.id);
      if (exists) throw new Error("Conversation already exists");
      this.assertConversationLimit(caps);
      if (messages.length > caps.maxMessagesPerConversation) throw new ConversationFullError();
      this.insertConversation(conversation);
      const insert = this.messageInserter();
      messages.forEach((message, index) => {
        insert.run({
          id: message.id,
          conversation_id: conversation.id,
          seq: index + 1,
          role: message.role,
          content: message.content,
          citations_json: message.citations ? JSON.stringify(message.citations) : null,
          prompt_version: message.promptVersion,
          created_at: message.createdAt,
        });
      });
    }).immediate();
  }

  rename(id: string, title: string): Conversation | undefined {
    const changed = this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id).changes;
    return changed > 0 ? this.get(id) : undefined;
  }

  list(scope: ChatScope, limit: number): Conversation[] {
    const select = `SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c`;
    const rows = scope.kind === "library"
      ? this.db.prepare(`${select} WHERE c.scope_kind = 'library'
          ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`).all(limit)
      : this.db.prepare(`${select} WHERE c.scope_kind = 'book' AND c.book_id = ?
          ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`).all(scope.bookId, limit);
    return (rows as ConversationRow[]).map(toConversation);
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      return this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
    })();
  }

  deleteForBook(bookId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM messages WHERE conversation_id IN
        (SELECT id FROM conversations WHERE scope_kind = 'book' AND book_id = ?)`).run(bookId);
      this.db.prepare("DELETE FROM conversations WHERE scope_kind = 'book' AND book_id = ?").run(bookId);
    })();
  }

  countAll(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number }).count;
  }

  reassign(fromBookId: string, toBookId: string): { conversations: number; citations: number } {
    return this.db.transaction(() => {
      const conversations = this.db.prepare(`UPDATE conversations SET book_id = ?
        WHERE scope_kind = 'book' AND book_id = ?`).run(toBookId, fromBookId).changes;
      // Citations are stored as serialized JSON; the exact fragment is rewritten in place
      // (the format is covered by the merge tests, ADR-7 risk).
      const from = `"bookId":"${fromBookId}"`;
      const to = `"bookId":"${toBookId}"`;
      const citations = this.db.prepare(`UPDATE messages SET citations_json = REPLACE(citations_json, ?, ?)
        WHERE citations_json IS NOT NULL AND instr(citations_json, ?) > 0`).run(from, to, from).changes;
      return { conversations, citations };
    })();
  }

  private insertConversation(conversation: Conversation): void {
    this.db.prepare(`INSERT INTO conversations (id, scope_kind, book_id, title, created_at, updated_at)
      VALUES (@id, @scope_kind, @book_id, @title, @created_at, @updated_at)`).run({
      id: conversation.id,
      scope_kind: conversation.scope.kind,
      book_id: conversation.scope.kind === "book" ? conversation.scope.bookId : null,
      title: conversation.title,
      created_at: conversation.createdAt,
      updated_at: conversation.updatedAt,
    });
  }

  /** The caller owns the transaction, so the count and the insert share one write lock. */
  private assertConversationLimit(caps: ConversationCaps): void {
    const max = Math.max(1, caps.maxConversations);
    const count = this.countAll();
    if (count >= max) throw new ConversationLimitError(max, count);
  }

  private messageInserter() {
    return this.db.prepare(`INSERT INTO messages
      (id, conversation_id, seq, role, content, citations_json, prompt_version, created_at)
      VALUES (@id, @conversation_id, @seq, @role, @content, @citations_json, @prompt_version, @created_at)`);
  }
}
