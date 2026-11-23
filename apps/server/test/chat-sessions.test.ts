import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../src/domain/errors.js";
import { BOOK, createChatFixture, passage } from "./chat-helpers.js";

const fixtures: ReturnType<typeof createChatFixture>[] = [];

function fixture(options: Parameters<typeof createChatFixture>[0] = {}) {
  const created = createChatFixture(options);
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.db.close();
});

const transcript = [
  { role: "user", content: "What is deep work?" },
  {
    role: "assistant",
    content: "Focused work without distraction.",
    citations: [
      { n: 1, passageId: 4, bookId: BOOK.id, bookTitle: "Ignored client title", page: 12, section: "Chapter 1" },
      { n: 2, passageId: 5, bookId: "deleted-book", page: null, section: null },
    ],
  },
];

describe("ChatSessions", () => {
  it("lists newest first with message counts and caps the page at 200", () => {
    const { sessions, chat, conversations } = fixture();
    for (let index = 0; index < 205; index += 1) {
      conversations.create({
        id: `c-${index}`,
        scope: { kind: "library" },
        title: `Title ${index}`,
        createdAt: index,
        updatedAt: index,
      });
    }
    const first = sessions.list({ limit: 500 });
    expect(first).toHaveLength(200);
    expect(first[0]).toMatchObject({ id: "c-204", messageCount: 0 });
    expect(sessions.list({ limit: 2 }).map((item) => item.id)).toEqual(["c-204", "c-203"]);
    expect(chat.status().sessionLimits.count).toBe(205);
  });

  it("renames without changing updatedAt and returns undefined for an unknown id", () => {
    const { sessions, conversations } = fixture();
    conversations.create({ id: "c1", scope: { kind: "library" }, title: "Old", createdAt: 1, updatedAt: 2 });

    expect(sessions.rename("c1", "  New title  ")).toMatchObject({ id: "c1", title: "New title", updatedAt: 2 });
    expect(() => sessions.rename("c1", "   ")).toThrow(ValidationError);
    expect(sessions.rename("missing", "Title")).toBeUndefined();
  });

  it("imports a validated transcript with re-derived citation titles", () => {
    const { sessions, conversations } = fixture();
    const imported = sessions.import({ scope: { kind: "library" }, messages: transcript });

    expect(imported).toMatchObject({
      title: "What is deep work?",
      scope: { kind: "library" },
      messageCount: 2,
    });
    expect(conversations.countAll()).toBe(1);
    expect(sessions.get(imported.id)?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(sessions.get(imported.id)?.messages[1]?.citations).toEqual([
      { n: 1, passageId: 4, bookId: BOOK.id, bookTitle: BOOK.title, page: 12, section: "Chapter 1" },
    ]);
  });

  it("accepts a custom title and a book scope with an existing book", () => {
    const { sessions } = fixture();
    const imported = sessions.import({
      scope: { kind: "book", bookId: BOOK.id },
      title: "Saved notes",
      messages: transcript,
    });
    expect(imported).toMatchObject({ title: "Saved notes", scope: { kind: "book", bookId: BOOK.id } });
  });

  it("rejects an unknown book, invalid alternation and an oversized message without writing", () => {
    const { sessions, conversations } = fixture();
    expect(() => sessions.import({ scope: { kind: "book", bookId: "missing" }, messages: transcript }))
      .toThrow(NotFoundError);
    expect(() => sessions.import({
      scope: { kind: "library" },
      messages: [{ role: "assistant", content: "a" }, { role: "user", content: "q" }],
    })).toThrow(ValidationError);
    expect(() => sessions.import({
      scope: { kind: "library" },
      messages: [{ role: "user", content: "q" }, { role: "assistant", content: "x".repeat(8_001) }],
    })).toThrow(ValidationError);
    expect(() => sessions.import({
      scope: { kind: "library" },
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "a",
          citations: Array.from({ length: 7 }, (_, index) => ({
            n: index + 1,
            passageId: index + 1,
            bookId: BOOK.id,
          })),
        },
      ],
    })).toThrow(ValidationError);
    expect(conversations.countAll()).toBe(0);
  });

  it("returns the detail with messages and counts a resumed conversation", async () => {
    const { chat, sessions, retriever, conversations } = fixture();
    retriever.hits = [passage()];
    const events = [];
    for await (const event of chat.stream({ message: "Question", scope: { kind: "library" } }, new AbortController().signal)) {
      events.push(event);
    }
    const id = (events[0] as { conversationId: string }).conversationId;
    expect(sessions.get(id)?.messages).toHaveLength(2);
    expect(sessions.list().find((item) => item.id === id)?.messageCount).toBe(2);
    expect(conversations.countAll()).toBe(1);
    expect(sessions.get("missing")).toBeUndefined();
  });
});
