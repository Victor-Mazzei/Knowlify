import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { BookRecommendations } from "../src/use-cases/BookRecommendations.js";
import type { BookCandidateDetails, BookCandidateSource, PassageRetriever } from "../src/ports/assistant.js";
import type { Logger, ProgressRepository } from "../src/ports/index.js";
import {
  BOOK,
  FakeLlmClient,
  collect,
  createChatFixture,
} from "./chat-helpers.js";

const providers: Server[] = [];
const apps: { app: FastifyInstance; db: Db }[] = [];
const fixtures: ReturnType<typeof createChatFixture>[] = [];
const original = {
  logLevel: config.logLevel,
  llm: { ...config.llm },
};

afterEach(async () => {
  for (const { app, db } of apps.splice(0)) {
    // The test made the database read-only; the app's close hook refreshes statistics.
    if (db.open) {
      try {
        db.pragma("query_only = OFF");
      } catch {
        // The database is already gone; closing it below is enough.
      }
    }
    await app.close();
    if (db.open) db.close();
  }
  for (const created of fixtures.splice(0)) if (created.db.open) created.db.close();
  for (const provider of providers.splice(0)) {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
  config.logLevel = original.logLevel;
  Object.assign(config.llm, original.llm);
});

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const emptyProgress: ProgressRepository = {
  get: () => undefined,
  getMany: () => new Map(),
  save: () => {},
  merge: () => ({ kept: false, progress: null }),
};

function recordingLogger(entries: string[]): Logger {
  const record = (...args: unknown[]) => {
    for (const value of args) {
      try {
        entries.push(typeof value === "string" ? value : JSON.stringify(value));
      } catch {
        entries.push(String(value));
      }
    }
  };
  return {
    info: (message) => record(message),
    error: (error, message) => record(error, message),
    warn: (message) => record(message),
    debug: (message) => record(message),
  };
}

describe("recommendation log sentinels with dependency failures", () => {
  it("never logs title, author, tag, passage or question sentinels on any recommendation path", async () => {
    const sentinels = {
      title: "TITLE-SENTINEL-RUST",
      author: "AUTHOR-SENTINEL-RUST",
      tag: "TAG-SENTINEL-RUST",
      passage: "PASSAGE-SENTINEL-RUST",
      none: "KUBERNETES-QUASAR-ONLY",
      unavailable: "UNAVAILABLE-QUASAR-ONLY",
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
    config.llm.url = `http://127.0.0.1:${port}/v1`;
    config.llm.apiKey = "test-key";
    config.llm.model = "test-model";
    config.llm.headers = [];
    config.llm.legacySessionHeader = false;

    const db = openDb(":memory:");
    new SqliteBookRepository(db).save({
      ...BOOK,
      id: "sentinel-book",
      title: sentinels.title,
      author: sentinels.author,
    });
    db.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES ('tag-sentinel',?,'tag-sentinel','gray',1)")
      .run(sentinels.tag);
    db.prepare("INSERT INTO book_tags (book_id,tag_id,created_at) VALUES ('sentinel-book','tag-sentinel',1)").run();
    db.prepare(`INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at,index_version)
      VALUES ('sentinel-book','ready',0,1,1,'1|lexical')`).run();
    db.prepare("INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES ('sentinel-book',0,?,1,NULL)")
      .run(`${sentinels.passage} rust web`);

    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const runner = {
      run: async () => { throw new Error("not used"); },
      embedQuery: async () => null,
      embeddings: () => ({ mode: "none" as const, model: null, state: "off" as const }),
      indexVersion: () => "1|lexical",
      onEmbeddingsReady: () => {},
      close: async () => {},
    };
    const { app } = await buildApp(db, { stream }, undefined, runner);
    await app.ready();
    apps.push({ app, db });

    const post = (payload: object) => app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: auth,
      payload,
    });

    const ready = await post({
      message: "recomende livros de rust web",
      scope: { kind: "library" },
      mode: "ask",
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.body).toContain('"type":"recommendations"');
    expect(ready.body).toContain('"status":"ready"');

    const none = await post({
      message: `recommend books about ${sentinels.none}`,
      scope: { kind: "library" },
      mode: "ask",
    });
    expect(none.statusCode).toBe(200);
    expect(none.body).toContain('"status":"none"');

    const libraryOff = await post({
      message: `recomende livros de ${sentinels.title}`,
      scope: { kind: "library" },
      mode: "ask",
      useLibrary: false,
    });
    expect(libraryOff.statusCode).toBe(200);
    expect(libraryOff.body).toContain('"status":"library_off"');

    const required = await post({
      message: `recomende ${sentinels.title}`,
      scope: { kind: "library" },
      mode: "ask",
      useLibrary: false,
      recommend: "on",
    });
    expect(required.statusCode).toBe(400);
    expect(required.json()).toMatchObject({ code: "library_required" });

    const invalidMode = await post({
      message: `recomende ${sentinels.title}`,
      scope: { kind: "library" },
      recommend: "on",
    });
    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json()).toMatchObject({ code: "invalid_mode" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const log = chunks.join("");
    expect(log.length).toBeGreaterThan(0);
    for (const sentinel of Object.values(sentinels)) {
      expect(log).not.toContain(sentinel);
    }
    // The SSE payload is not a log; the candidate title legitimately travels there.
    expect(ready.body).toContain(sentinels.title);
  });

  it("never logs the question on the unavailable path", async () => {
    const sentinel = "UNAVAILABLE-QUASAR-ONLY";
    const entries: string[] = [];
    const retriever: PassageRetriever = {
      search: async () => ({ mode: "lexical", hits: [], unavailable: true }),
    };
    const created = createChatFixture({ retriever, log: recordingLogger(entries) });
    fixtures.push(created);

    const events = await collect(created.chat.stream({
      message: `recommend books about ${sentinel}`,
      scope: { kind: "library" },
      mode: "ask",
    }, new AbortController().signal));

    expect(events[1]).toMatchObject({ type: "recommendations", status: "unavailable" });
    expect(entries.join("\n")).not.toContain(sentinel);
  });

  it("never logs chat content when SQLite rejects the import, the rename and the turn write", async () => {
    const sentinels = {
      importTitle: "IMPORT-TITLE-SENTINEL-RUST",
      importUser: "IMPORT-USER-SENTINEL-RUST",
      importAssistant: "IMPORT-ASSISTANT-SENTINEL-RUST",
      rename: "RENAME-SENTINEL-RUST",
      question: "QUESTION-SENTINEL-RUST",
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

    // One saved conversation exists before the database becomes read-only, so the
    // rename path reaches the failing write instead of a 404.
    const created = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth,
      payload: {
        scope: { kind: "library" },
        messages: [{ role: "user", content: "seed" }, { role: "assistant", content: "answer" }],
      },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().id as string;

    db.pragma("query_only = ON");

    const imported = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth,
      payload: {
        scope: { kind: "library" },
        title: sentinels.importTitle,
        messages: [
          { role: "user", content: sentinels.importUser },
          { role: "assistant", content: sentinels.importAssistant },
        ],
      },
    });
    expect(imported.statusCode).toBe(500);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversationId}`,
      headers: auth,
      payload: { title: sentinels.rename },
    });
    expect(renamed.statusCode).toBe(500);

    const turn = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: auth,
      payload: { message: sentinels.question, scope: { kind: "book", bookId: BOOK.id } },
    });
    // The stream started, so the write failure is an SSE error, not a JSON 500.
    expect(turn.statusCode).toBe(200);
    expect(turn.body).toContain('"type":"error"');
    expect(turn.body).not.toContain(sentinels.question);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const log = chunks.join("");
    expect(log.length).toBeGreaterThan(0);
    for (const sentinel of Object.values(sentinels)) {
      expect(log).not.toContain(sentinel);
    }
    expect(log).not.toContain("INSERT INTO");
    expect(log).not.toContain("query_only");
  });

  it("never logs the question or a passage when the retriever fails", async () => {
    const sentinel = "RETRIEVER-SENTINEL-RUST";
    const entries: string[] = [];
    const retriever: PassageRetriever = {
      search: async () => {
        throw new Error(`${sentinel} exploded while searching`);
      },
    };
    const created = createChatFixture({
      retriever,
      log: recordingLogger(entries),
    });
    fixtures.push(created);

    const events = await collect(created.chat.stream({
      message: `Question with ${sentinel}`,
      scope: { kind: "library" },
    }, new AbortController().signal));

    expect(events.map((event) => event.type)).toEqual(["sources", "error"]);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "search_failed" });
    const log = entries.join("\n");
    expect(log).toContain("chat retrieval failed");
    expect(log).not.toContain(sentinel);
  });

  it("never logs the terms when metadataMatches or details fails", async () => {
    const sentinel = "METADATA-SENTINEL-RUST";
    const entries: string[] = [];
    const failing: BookCandidateSource = {
      metadataMatches: () => {
        throw new Error(`${sentinel} metadata exploded`);
      },
      details: (): BookCandidateDetails[] => {
        throw new Error(`${sentinel} details exploded`);
      },
    };
    const created = createChatFixture({
      candidateSource: failing,
      recommendations: new BookRecommendations(failing, emptyProgress, recordingLogger(entries)),
    });
    fixtures.push(created);

    const events = await collect(created.chat.stream({
      message: `recomende livros de ${sentinel}`,
      scope: { kind: "library" },
      mode: "ask",
    }, new AbortController().signal));

    expect(events[1]).toMatchObject({ type: "recommendations", status: "unavailable" });
    const log = entries.join("\n");
    expect(log).toContain("metadata lookup failed");
    expect(log).not.toContain(sentinel);
  });

  it("never logs the question when the progress read fails", async () => {
    const sentinel = "PROGRESS-SENTINEL-RUST";
    const entries: string[] = [];
    const created = createChatFixture({
      books: [{ ...BOOK, title: "Rust", id: "rust" }],
      candidateSource: {
        metadataMatches: () => ["rust"],
        details: () => [{
          bookId: "rust",
          title: "Rust",
          author: "Author",
          format: "epub",
          language: null,
          series: null,
          description: null,
          tags: [],
          hasCover: false,
          coverRev: null,
        }],
      },
      recommendations: new BookRecommendations(
        {
          metadataMatches: () => ["rust"],
          details: () => [{
            bookId: "rust",
            title: "Rust",
            author: "Author",
            format: "epub",
            language: null,
            series: null,
            description: null,
            tags: [],
            hasCover: false,
            coverRev: null,
          }],
        },
        {
          getMany: () => {
            throw new Error(`${sentinel} progress exploded`);
          },
          get: () => undefined,
          save: () => {},
          merge: () => ({ kept: false, progress: null }),
        },
        recordingLogger(entries),
      ),
    });
    fixtures.push(created);

    const events = await collect(created.chat.stream({
      message: "recomende livros de Rust",
      scope: { kind: "library" },
      mode: "ask",
    }, new AbortController().signal));

    expect(events[1]).toMatchObject({ type: "recommendations", status: "ready" });
    const log = entries.join("\n");
    expect(log).toContain("progress lookup failed");
    expect(log).not.toContain(sentinel);
  });

  it("does not leak the question through the LLM client on a normal recommendation", async () => {
    const sentinel = "ANSWER-SENTINEL-RUST";
    const entries: string[] = [];
    const llm = new FakeLlmClient();
    llm.chunks = [`An answer ${sentinel}`];
    const created = createChatFixture({
      llm,
      books: [{ ...BOOK, id: "rust", title: "Rust" }],
      candidateSource: {
        metadataMatches: () => ["rust"],
        details: () => [{
          bookId: "rust",
          title: "Rust",
          author: "Author",
          format: "epub",
          language: null,
          series: null,
          description: null,
          tags: [],
          hasCover: false,
          coverRev: null,
        }],
      },
      log: recordingLogger(entries),
    });
    fixtures.push(created);

    const events = await collect(created.chat.stream({
      message: "recomende livros de Rust",
      scope: { kind: "library" },
      mode: "ask",
    }, new AbortController().signal));

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(entries.join("\n")).not.toContain(sentinel);
  });
});
