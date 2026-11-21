import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteConversationRepository } from "../src/adapters/storage/SqliteConversationRepository.js";
import { MAX_CONVERSATIONS, MAX_MESSAGES_PER_CONVERSATION } from "../src/domain/assistant/Conversation.js";
import type { ChatMessage, Conversation } from "../src/domain/assistant/Conversation.js";
import { ConversationFullError } from "../src/domain/assistant/errors.js";

const CAPS = { maxConversations: MAX_CONVERSATIONS, maxMessagesPerConversation: MAX_MESSAGES_PER_CONVERSATION };
const databases: Db[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(): Db {
  const db = openDb(":memory:");
  databases.push(db);
  return db;
}

function conversation(id: string, scope: Conversation["scope"], at = 1): Conversation {
  return { id, scope, title: `Title ${id}`, createdAt: at, updatedAt: at };
}

function message(id: string, role: ChatMessage["role"], content: string, at = 1): ChatMessage {
  return { id, role, content, citations: null, promptVersion: null, createdAt: at };
}

function turn(
  conversationId: string,
  ids: readonly [string, string],
  options: { at?: number; newConversation?: Conversation | null } = {},
) {
  const at = options.at ?? 1;
  return {
    conversationId,
    newConversation: options.newConversation ?? null,
    user: message(ids[0], "user", "q", at),
    assistant: message(ids[1], "assistant", "a", at),
  };
}

describe("SqliteConversationRepository", () => {
  it("round-trips conversations and messages, including citations", () => {
    const db = database();
    const repo = new SqliteConversationRepository(db);
    repo.create(conversation("c1", { kind: "book", bookId: "book-1" }));

    expect(repo.get("c1")).toEqual(conversation("c1", { kind: "book", bookId: "book-1" }));
    expect(repo.get("missing")).toBeUndefined();

    const user = message("m1", "user", "What is deep work?");
    const assistant: ChatMessage = {
      ...message("m2", "assistant", "Focused work [1]."),
      citations: [{ n: 1, passageId: 4, bookId: "book-1", bookTitle: "Deep Work", page: 12, section: "Chapter 1" }],
      promptVersion: "feynman-1",
    };
    repo.saveTurn({ conversationId: "c1", newConversation: null, user, assistant }, CAPS, 50);

    expect(repo.messages("c1")).toEqual([user, assistant]);
    expect(repo.get("c1")?.updatedAt).toBe(50);
    expect(() => repo.saveTurn({ conversationId: "missing", newConversation: null, user, assistant }, CAPS, 1))
      .toThrow("Conversation does not exist");
  });

  it("creates a conversation and its first turn in the same operation", () => {
    const db = database();
    const repo = new SqliteConversationRepository(db);
    const fresh = conversation("fresh", { kind: "library" }, 7);

    repo.saveTurn(turn("fresh", ["u", "a"], { at: 7, newConversation: fresh }), CAPS, 7);

    expect(repo.get("fresh")).toEqual(fresh);
    expect(repo.messages("fresh").map((item) => item.id)).toEqual(["u", "a"]);
    expect(() => repo.saveTurn(turn("fresh", ["u2", "a2"], { newConversation: fresh }), CAPS, 8))
      .toThrow("Conversation already exists");
  });

  it("orders and filters conversations by scope", () => {
    const db = database();
    const repo = new SqliteConversationRepository(db);
    repo.create(conversation("library-old", { kind: "library" }, 1));
    repo.create(conversation("library-new", { kind: "library" }, 2));
    repo.create(conversation("book-a", { kind: "book", bookId: "a" }, 3));
    repo.create(conversation("book-b", { kind: "book", bookId: "b" }, 4));

    expect(repo.list({ kind: "library" }, 10).map((item) => item.id)).toEqual(["library-new", "library-old"]);
    expect(repo.list({ kind: "book", bookId: "a" }, 10).map((item) => item.id)).toEqual(["book-a"]);
    expect(repo.list({ kind: "library" }, 1).map((item) => item.id)).toEqual(["library-new"]);
  });

  it("deletes a conversation and its messages, and removes book conversations", () => {
    const db = database();
    const repo = new SqliteConversationRepository(db);
    repo.create(conversation("library", { kind: "library" }));
    repo.create(conversation("book-a", { kind: "book", bookId: "a" }));
    repo.create(conversation("book-b", { kind: "book", bookId: "b" }));
    for (const id of ["library", "book-a", "book-b"]) {
      repo.saveTurn(turn(id, [`${id}-u`, `${id}-a`], { at: 10 }), CAPS, 10);
    }

    repo.deleteForBook("a");
    expect(repo.list({ kind: "book", bookId: "a" }, 10)).toEqual([]);
    expect(repo.messages("book-a")).toEqual([]);
    expect(repo.messages("book-b")).toHaveLength(2);

    expect(repo.delete("book-b")).toBe(true);
    expect(repo.delete("book-b")).toBe(false);
    expect(repo.messages("book-b")).toEqual([]);
    expect(repo.messages("library")).toHaveLength(2);
  });

  it("counts conversations and drops the least recently updated one beyond the cap", () => {
    const db = database();
    const repo = new SqliteConversationRepository(db);
    repo.create(conversation("old", { kind: "library" }, 1));
    repo.create(conversation("new", { kind: "library" }, 2));
    repo.saveTurn(turn("new", ["u", "a"], { at: 100 }), CAPS, 100);

    expect(repo.countAll()).toBe(2);
    repo.saveTurn(
      turn("fresh", ["u2", "a2"], { at: 200, newConversation: conversation("fresh", { kind: "library" }, 200) }),
      { ...CAPS, maxConversations: 2 },
      200,
    );
    expect(repo.countAll()).toBe(2);
    expect(repo.get("old")).toBeUndefined();
    expect(repo.messages("new")).toHaveLength(2);
    expect(repo.messages("fresh")).toHaveLength(2);
  });

  it("rejects a turn that would exceed the message cap without changing the conversation", () => {
    const db = database();
    const repo = new SqliteConversationRepository(db);
    repo.create(conversation("full", { kind: "library" }));
    for (let index = 0; index < MAX_MESSAGES_PER_CONVERSATION / 2; index += 1) {
      repo.saveTurn(turn("full", [`u${index}`, `a${index}`]), CAPS, index + 1);
    }
    expect(repo.messages("full")).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);

    expect(() => repo.saveTurn(turn("full", ["overflow-u", "overflow-a"]), CAPS, 99))
      .toThrow(ConversationFullError);
    expect(repo.messages("full")).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(repo.get("full")?.updatedAt).toBe(MAX_MESSAGES_PER_CONVERSATION / 2);
  });

  it("rolls back eviction and the new conversation when the turn fails midway", () => {
    const db = database();
    const repo = new SqliteConversationRepository(db);
    repo.create(conversation("old-0", { kind: "library" }, 0));
    repo.saveTurn(turn("old-0", ["kept-u", "kept-a"], { at: 0 }), CAPS, 0);
    for (let index = 1; index < MAX_CONVERSATIONS; index += 1) {
      repo.create(conversation(`old-${index}`, { kind: "library" }, index));
    }

    // Duplicate message ids reach the primary key after the oldest conversation
    // was already deleted, so the rollback must bring it (and its history) back.
    const duplicate = message("same-id", "user", "q", 300);
    expect(() => repo.saveTurn(
      {
        conversationId: "fresh",
        newConversation: conversation("fresh", { kind: "library" }, 300),
        user: duplicate,
        assistant: { ...duplicate, role: "assistant" },
      },
      CAPS,
      300,
    )).toThrow();

    expect(repo.countAll()).toBe(MAX_CONVERSATIONS);
    expect(repo.get("old-0")).toBeDefined();
    expect(repo.messages("old-0").map((item) => item.id)).toEqual(["kept-u", "kept-a"]);
    expect(repo.get("fresh")).toBeUndefined();
  });

  it("keeps message sequence unique per conversation", () => {
    const db = database();
    const repo = new SqliteConversationRepository(db);
    repo.create(conversation("c", { kind: "library" }));
    repo.saveTurn(turn("c", ["u1", "a1"]), CAPS, 1);
    repo.saveTurn(turn("c", ["u2", "a2"]), CAPS, 2);
    const rows = db.prepare("SELECT seq FROM messages WHERE conversation_id = 'c' ORDER BY seq").all() as { seq: number }[];
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  it("enforces the scope check constraint", () => {
    const db = database();
    expect(() => db.prepare("INSERT INTO conversations (id, scope_kind, book_id, title, created_at, updated_at) VALUES ('x','library','book',1,1,1)").run())
      .toThrow();
    expect(() => db.prepare("INSERT INTO conversations (id, scope_kind, book_id, title, created_at, updated_at) VALUES ('x','book',NULL,1,1,1)").run())
      .toThrow();
  });

  it("migrates a file database to v5 and keeps it idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "knowlify-chat-migration-"));
    roots.push(root);
    const path = join(root, "app.db");

    const first = openDb(path);
    expect(first.pragma("user_version", { simple: true })).toBe(11);
    new SqliteConversationRepository(first).create(conversation("kept", { kind: "library" }));
    first.close();

    const second = openDb(path);
    databases.push(second);
    expect(second.pragma("user_version", { simple: true })).toBe(11);
    expect(new SqliteConversationRepository(second).get("kept")).toEqual(conversation("kept", { kind: "library" }));
    expect(second.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversations','messages') ORDER BY name").all())
      .toEqual([{ name: "conversations" }, { name: "messages" }]);
  });
});
