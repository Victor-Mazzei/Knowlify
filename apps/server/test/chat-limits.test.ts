import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteConversationRepository } from "../src/adapters/storage/SqliteConversationRepository.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { ChatLimitsError, ChatLimitsSettings } from "../src/use-cases/ChatLimitsSettings.js";
import type { ChatLimitsStore } from "../src/ports/llm-settings.js";
import { ConversationLimitError } from "../src/domain/assistant/errors.js";
import { FakeLlmClient, FakeRetriever, collect, createChatFixture, passage } from "./chat-helpers.js";

const fixtures: ReturnType<typeof createChatFixture>[] = [];
const apps: { app: FastifyInstance; db: Db }[] = [];

function fixture(options: Parameters<typeof createChatFixture>[0] = {}) {
  const created = createChatFixture(options);
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  for (const created of fixtures.splice(0)) created.db.close();
  for (const { app, db } of apps.splice(0)) {
    await app.close();
    db.close();
  }
  config.chat.maxConversations = null;
  config.llmLocked = false;
});

function memoryStore(initial: string | null = null): ChatLimitsStore & { value: string | null } {
  const store = {
    value: initial,
    load(): string | null {
      return store.value;
    },
    save(value: number | null): void {
      store.value = value === null ? null : String(value);
    },
  };
  return store;
}

function settings(options: {
  env?: number | null;
  count?: number;
  locked?: boolean;
  store?: ChatLimitsStore;
  now?: () => number;
} = {}) {
  let now = 1_000;
  return new ChatLimitsSettings({
    store: options.store ?? memoryStore(),
    env: { maxConversations: options.env ?? null },
    locked: options.locked ?? false,
    count: () => options.count ?? 0,
    clock: { now: () => options.now?.() ?? now },
  });
}

async function appWithChatLimits(env: number | null): Promise<FastifyInstance> {
  config.chat.maxConversations = env;
  const db = openDb(":memory:");
  const { app } = await buildApp(db, false);
  await app.ready();
  apps.push({ app, db });
  return app;
}

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

describe("blocking session limit", () => {
  it("creates exactly N sessions and blocks the next one before retrieval, provider and rate limit", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    const { chat, sessions, conversations, advance } = fixture({
      retriever,
      llm,
      limits: { maxConversations: 3, ratePerMin: 1 },
    });

    for (let index = 0; index < 2; index += 1) {
      conversations.create({
        id: `seeded-${index}`,
        scope: { kind: "library" },
        title: `Seed ${index}`,
        createdAt: index,
        updatedAt: index,
      });
    }
    const before = conversations.countAll();

    // The third session is allowed even though the shared per-minute bucket already
    // has no hit (the seeded sessions were written directly).
    await collect(chat.stream({ message: "Third", scope: { kind: "library" } }, new AbortController().signal));
    expect(conversations.countAll()).toBe(3);
    const queries = retriever.queries.length;
    const requests = llm.requests.length;
    advance(60_000);

    const blocked = await collect(chat.stream({ message: "Fourth", scope: { kind: "library" } }, new AbortController().signal))
      .catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ConversationLimitError);
    expect(blocked).toMatchObject({ limit: 3, count: 3 });
    expect(conversations.countAll()).toBe(3);
    expect(retriever.queries).toHaveLength(queries);
    expect(llm.requests).toHaveLength(requests);

    // The rejected turn did not consume the rate limit: the next turn in an existing
    // session still works with a one-per-minute bucket.
    await collect(chat.stream({ conversationId: "seeded-0", message: "Continue", scope: { kind: "library" } }, new AbortController().signal));
    expect(conversations.messages("seeded-0")).toHaveLength(2);
    advance(60_000);

    // Ask never counts against the limit.
    const ask = await collect(chat.stream({ message: "Ask", scope: { kind: "library" }, mode: "ask" }, new AbortController().signal));
    expect(ask.at(-1)).toMatchObject({ type: "done", persisted: false });
    expect(conversations.countAll()).toBe(before + 1);
    expect(sessions.list().length).toBe(3);
  });

  it("blocks imports at the limit without writing anything", () => {
    const { sessions, conversations } = fixture({ limits: { maxConversations: 1 } });
    sessions.import({
      scope: { kind: "library" },
      messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
    });
    expect(conversations.countAll()).toBe(1);

    let failure: unknown;
    try {
      sessions.import({
        scope: { kind: "library" },
        messages: [{ role: "user", content: "q2" }, { role: "assistant", content: "a2" }],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConversationLimitError);
    expect(conversations.countAll()).toBe(1);
  });

  it("admits only one of two simultaneous new sessions at limit minus one", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat, conversations } = fixture({ retriever, limits: { maxConversations: 2 } });
    conversations.create({ id: "existing", scope: { kind: "library" }, title: "Existing", createdAt: 1, updatedAt: 1 });

    const results = await Promise.allSettled([
      collect(chat.stream({ message: "First", scope: { kind: "library" } }, new AbortController().signal)),
      collect(chat.stream({ message: "Second", scope: { kind: "library" } }, new AbortController().signal)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected && rejected.status === "rejected" ? rejected.reason : undefined)
      .toBeInstanceOf(ConversationLimitError);
    expect(conversations.countAll()).toBe(2);
  });
});

describe("ChatLimitsSettings", () => {
  it("resolves database, environment and default in that order", () => {
    const store = memoryStore("150");
    const fromDb = settings({ env: 100, store });
    fromDb.bootstrap();
    expect(fromDb.get()).toMatchObject({ maxConversations: 150, source: "db", count: 0 });
    expect(fromDb.current()).toBe(150);

    const fromEnv = settings({ env: 100 });
    fromEnv.bootstrap();
    expect(fromEnv.get()).toMatchObject({ maxConversations: 100, source: "env" });
    expect(fromEnv.current()).toBe(100);

    const fromDefault = settings();
    fromDefault.bootstrap();
    expect(fromDefault.get()).toMatchObject({ maxConversations: 200, default: 200, min: 20, max: 5000, source: "default" });
  });

  it("ignores an unreadable or out-of-range stored value without logging it", () => {
    for (const stored of ["abc", "19", "5001", "20.5", ""]) {
      const warnings: string[] = [];
      const instance = new ChatLimitsSettings({
        store: memoryStore(stored),
        env: { maxConversations: 100 },
        locked: false,
        count: () => 0,
        log: { info: () => {}, error: () => {}, warn: (message) => warnings.push(message) },
      });
      instance.bootstrap();
      expect(instance.current()).toBe(100);
      if (stored) expect(warnings.join("\n")).not.toContain(stored);
    }
  });

  it("rejects invalid values and keeps the previous one", () => {
    const instance = settings({ env: 100 });
    instance.bootstrap();
    for (const value of [19, 5001, 20.5, "abc", true, {}, [], 0, -1]) {
      let failure: unknown;
      try {
        instance.update({ maxConversations: value });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ChatLimitsError);
      expect(failure).toMatchObject({ code: "invalid_value", status: 400 });
      expect((failure as Error).message).toContain("20");
      expect((failure as Error).message).toContain("5000");
    }
    for (const value of ["abc", 19, 5001]) {
      let failure: unknown;
      try {
        instance.update({ maxConversations: value });
      } catch (error) {
        failure = error;
      }
      expect((failure as Error).message).not.toContain(String(value));
    }
    expect(instance.get().maxConversations).toBe(100);
    expect(instance.update({ maxConversations: 20 }).maxConversations).toBe(20);
    expect(instance.update({ maxConversations: 5000 }).maxConversations).toBe(5000);
    expect(instance.update({ maxConversations: null }).maxConversations).toBe(100);
  });

  it("reduces the limit below the existing count without deleting anything", () => {
    const db = openDb(":memory:");
    const conversations = new SqliteConversationRepository(db);
    try {
      for (let index = 0; index < 25; index += 1) {
        conversations.create({
          id: `c-${index}`,
          scope: { kind: "library" },
          title: `C ${index}`,
          createdAt: index,
          updatedAt: index,
        });
      }
      const instance = settings({ env: 30, count: conversations.countAll() });
      instance.bootstrap();
      const reduced = instance.update({ maxConversations: 20 });
      expect(reduced).toMatchObject({ maxConversations: 20, count: 25, source: "db" });
      expect(conversations.countAll()).toBe(25);

      // Existing sessions keep accepting turns.
      conversations.saveTurn({
        conversationId: "c-0",
        newConversation: null,
        user: { id: "u", role: "user", content: "q", citations: null, promptVersion: null, createdAt: 100 },
        assistant: { id: "a", role: "assistant", content: "a", citations: null, promptVersion: null, createdAt: 100 },
      }, { maxConversations: instance.current(), maxMessagesPerConversation: 100 }, 100);
      expect(conversations.messages("c-0")).toHaveLength(2);

      // Deleting one is not enough until the count is below the limit.
      conversations.delete("c-1");
      expect(conversations.countAll()).toBe(24);
      let failure: unknown;
      try {
        conversations.saveTurn({
          conversationId: "new",
          newConversation: { id: "new", scope: { kind: "library" }, title: "New", createdAt: 200, updatedAt: 200 },
          user: { id: "nu", role: "user", content: "q", citations: null, promptVersion: null, createdAt: 200 },
          assistant: { id: "na", role: "assistant", content: "a", citations: null, promptVersion: null, createdAt: 200 },
        }, { maxConversations: instance.current(), maxMessagesPerConversation: 100 }, 200);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConversationLimitError);

      // Raising the limit frees new sessions again.
      instance.update({ maxConversations: 30 });
      conversations.saveTurn({
        conversationId: "new",
        newConversation: { id: "new", scope: { kind: "library" }, title: "New", createdAt: 200, updatedAt: 200 },
        user: { id: "nu", role: "user", content: "q", citations: null, promptVersion: null, createdAt: 200 },
        assistant: { id: "na", role: "assistant", content: "a", citations: null, promptVersion: null, createdAt: 200 },
      }, { maxConversations: instance.current(), maxMessagesPerConversation: 100 }, 200);
      expect(conversations.countAll()).toBe(25);
    } finally {
      db.close();
    }
  });

  it("is locked to the environment with KNOWLIFY_LLM_LOCKED", () => {
    const store = memoryStore("300");
    const instance = settings({ env: 100, locked: true, store });
    instance.bootstrap();
    expect(instance.get()).toMatchObject({ maxConversations: 100, source: "env", locked: true });
    expect(() => instance.update({ maxConversations: 200 })).toThrow(ChatLimitsError);
    try {
      instance.update({ maxConversations: 200 });
    } catch (error) {
      expect(error).toMatchObject({ code: "llm_locked", status: 403 });
    }
    expect(store.value).toBe("300");
  });

  it("rate limits writes with Retry-After", () => {
    let now = 1_000;
    const instance = new ChatLimitsSettings({
      store: memoryStore(),
      env: { maxConversations: null },
      locked: false,
      count: () => 0,
      clock: { now: () => now },
      writeRatePerMin: 2,
    });
    instance.bootstrap();
    instance.update({ maxConversations: 20 });
    instance.update({ maxConversations: 21 });
    let failure: unknown;
    try {
      instance.update({ maxConversations: 22 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "rate_limited", status: 429 });
    expect((failure as ChatLimitsError).retryAfterSec).toBeGreaterThan(0);
    now += 60_000;
    expect(instance.update({ maxConversations: 22 }).maxConversations).toBe(22);
  });
});

describe("GET/PUT /api/settings/chat", () => {
  it("requires Basic auth and returns the documented view", async () => {
    const app = await appWithChatLimits(100);
    expect((await app.inject({ method: "GET", url: "/api/settings/chat" })).statusCode).toBe(401);

    const response = await app.inject({ method: "GET", url: "/api/settings/chat", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      maxConversations: 100,
      default: 200,
      min: 20,
      max: 5000,
      count: 0,
      source: "env",
      locked: false,
    });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings/chat",
      headers: auth,
      payload: { maxConversations: 250 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ maxConversations: 250, source: "db", count: 0 });
    expect((await app.inject({ method: "GET", url: "/api/settings/chat", headers: auth })).json())
      .toMatchObject({ maxConversations: 250, source: "db" });

    for (const value of [19, 5001, 20.5, "abc", true, {}, []]) {
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/settings/chat",
        headers: auth,
        payload: { maxConversations: value },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: "invalid_value" });
    }
    expect((await app.inject({ method: "GET", url: "/api/settings/chat", headers: auth })).json())
      .toMatchObject({ maxConversations: 250 });

    const restored = await app.inject({
      method: "PUT",
      url: "/api/settings/chat",
      headers: auth,
      payload: { maxConversations: null },
    });
    expect(restored.json()).toMatchObject({ maxConversations: 100, source: "env" });

    const tooLarge = await app.inject({
      method: "PUT",
      url: "/api/settings/chat",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ maxConversations: 200, padding: "x".repeat(5_000) }),
    });
    expect(tooLarge.statusCode).toBe(413);
  });

  it("refuses writes when the LLM configuration is locked", async () => {
    config.llmLocked = true;
    const app = await appWithChatLimits(100);
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings/chat",
      headers: auth,
      payload: { maxConversations: 300 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "llm_locked" });
    expect((await app.inject({ method: "GET", url: "/api/settings/chat", headers: auth })).json())
      .toMatchObject({ maxConversations: 100, locked: true, source: "env" });
  });
});
