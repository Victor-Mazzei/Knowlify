import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { FastifyInstance } from "fastify";
import { BOOK } from "./chat-helpers.js";

const providers: Server[] = [];
const apps: { app: FastifyInstance; db: Db }[] = [];
const original = {
  logLevel: config.logLevel,
  chatLimit: config.chat.maxConversations,
  llm: { ...config.llm },
};

afterEach(async () => {
  for (const { app, db } of apps.splice(0)) {
    await app.close();
    db.close();
  }
  for (const provider of providers.splice(0)) {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
  config.logLevel = original.logLevel;
  config.chat.maxConversations = original.chatLimit;
  Object.assign(config.llm, original.llm);
});

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

describe("chat log sentinels", () => {
  it("never logs messages, history, excerpts, titles, imports or settings values at trace level", async () => {
    const sentinels = {
      message: "MESSAGE-SENTINEL-QUESTION",
      history: "HISTORY-SENTINEL-FOLLOWUP",
      excerpt: "EXCERPT-SENTINEL-TEXT",
      ask: "ASK-SENTINEL-QUESTION",
      importTitle: "IMPORT-TITLE-SENTINEL",
      importUser: "IMPORT-USER-SENTINEL",
      importAssistant: "IMPORT-ASSISTANT-SENTINEL",
      citationTitle: "CITATION-TITLE-SENTINEL",
      rename: "RENAME-SENTINEL",
      badTitle: "BAD-TITLE-SENTINEL",
      limit: "LIMIT-SENTINEL",
      limitImport: "LIMIT-IMPORT-SENTINEL",
      invalidMode: "INVALID-MODE-SENTINEL",
      missingBook: "MISSING-BOOK-SENTINEL",
      settings: "SETTINGS-SENTINEL",
    };

    const provider = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    providers.push(provider);
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const { port } = provider.address() as AddressInfo;

    config.logLevel = "trace";
    config.chat.maxConversations = 2;
    config.llm.url = `http://127.0.0.1:${port}/v1`;
    config.llm.apiKey = "test-key";
    config.llm.model = "test-model";
    config.llm.headers = [];
    config.llm.legacySessionHeader = false;

    const db = openDb(":memory:");
    new SqliteBookRepository(db).save(BOOK);
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const { app } = await buildApp(db, { stream });
    await app.ready();
    apps.push({ app, db });

    const post = (payload: object) => app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: auth,
      payload,
    });

    const first = await post({
      message: sentinels.message,
      scope: {
        kind: "book",
        bookId: BOOK.id,
        excerpt: sentinels.excerpt,
        excerptKind: "selection",
      },
    });
    expect(first.statusCode).toBe(200);
    const firstEvents = first.body
      .split("\n\n")
      .flatMap((block) => block.split("\n"))
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as { type: string; conversationId?: string });
    const conversationId = firstEvents[0]?.conversationId;
    expect(conversationId).toBeTruthy();

    expect((await post({
      conversationId,
      message: sentinels.history,
      scope: { kind: "book", bookId: BOOK.id },
    })).statusCode).toBe(200);

    expect((await post({
      message: sentinels.ask,
      scope: { kind: "library" },
      mode: "ask",
      useLibrary: false,
    })).statusCode).toBe(200);

    const imported = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth,
      payload: {
        scope: { kind: "library" },
        title: sentinels.importTitle,
        messages: [
          { role: "user", content: sentinels.importUser },
          {
            role: "assistant",
            content: sentinels.importAssistant,
            citations: [{
              n: 1,
              passageId: 1,
              bookId: BOOK.id,
              bookTitle: sentinels.citationTitle,
              page: 1,
              section: null,
            }],
          },
        ],
      },
    });
    expect(imported.statusCode).toBe(201);
    const importedId = imported.json().id as string;

    expect((await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${importedId}`,
      headers: auth,
      payload: { title: sentinels.rename },
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${importedId}`,
      headers: auth,
      payload: { title: `${sentinels.badTitle}\ninside` },
    })).statusCode).toBe(400);

    const limited = await post({ message: sentinels.limit, scope: { kind: "book", bookId: BOOK.id } });
    expect(limited.statusCode).toBe(409);
    expect(limited.json()).toMatchObject({ code: "conversation_limit" });

    const limitedImport = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth,
      payload: {
        scope: { kind: "library" },
        messages: [{ role: "user", content: sentinels.limitImport }, { role: "assistant", content: "a" }],
      },
    });
    expect(limitedImport.statusCode).toBe(409);

    const invalidMode = await post({
      conversationId,
      message: sentinels.invalidMode,
      scope: { kind: "library" },
      mode: "ask",
    });
    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json()).toMatchObject({ code: "invalid_mode" });

    expect((await post({
      message: sentinels.missingBook,
      scope: { kind: "book", bookId: "missing" },
    })).statusCode).toBe(404);

    const invalidSettings = await app.inject({
      method: "PUT",
      url: "/api/settings/chat",
      headers: auth,
      payload: { maxConversations: sentinels.settings },
    });
    expect(invalidSettings.statusCode).toBe(400);
    expect(invalidSettings.json()).toMatchObject({ code: "invalid_value" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const log = chunks.join("");
    expect(log.length).toBeGreaterThan(0);
    for (const sentinel of Object.values(sentinels)) {
      expect(log).not.toContain(sentinel);
    }
  });
});
