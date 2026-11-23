import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import { createServices } from "../src/index.js";
import { config } from "../src/config.js";
import { Chat, type ChatEvent, type ChatTurnInput } from "../src/use-cases/Chat.js";
import type { IngestJob, IngestOutcome, IngestionRunner } from "../src/ports/knowledge.js";
import type { Logger } from "../src/ports/index.js";
import { createChatFixture, FakeLlmClient } from "./chat-helpers.js";

/**
 * Regression for the production freeze: FTS5 ranking runs in SQLite and its cost grows
 * with the number of matching chunks, while better-sqlite3 is synchronous. Retrieval used
 * to run inside the chat request, so a large library blocked every route (including
 * `/health`) for seconds to minutes. It now runs in the search worker; this test fails if
 * the loop blocks while a turn searches a large index.
 */

const LOOP_MAX_MS = 150;
const CHUNKS = 60_000;
const roots: string[] = [];
const databases: Db[] = [];
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const vocabulary = (
  "the of and to in is that for it as with was on be by this are or from at not have an but they which "
  + "you were all we when there can more one if has about what will their would who so no up out do like "
  + "deep focus attention book reading chapter author concept practice learning memory habit system process "
  + "question answer evidence example study research science knowledge library passage retrieval vector search"
).split(/\s+/);

function passageText(seed: number): string {
  const words: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    const rank = Math.floor(Math.abs(Math.sin(seed * 12.9898 + index * 78.233)) * vocabulary.length);
    words.push(vocabulary[Math.min(vocabulary.length - 1, Math.floor(Math.pow(rank / vocabulary.length, 1.7) * vocabulary.length))]!);
  }
  return `Passage ${seed}. ${words.join(" ")}.`;
}

function seedLargeIndex(db: Db, chunks: number): void {
  const book = db.prepare(`INSERT INTO books (id,title,author,format,path,size,added_at,source_id,mtime,status)
    VALUES (?,?,?,'pdf',?,?,?,'src',?,'ready')`);
  book.run("book-large", "Deep Work and Attention", "Author", "/library/large.pdf", 10, 1, 1);
  const index = db.prepare(`INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at,index_version)
    VALUES (?,'ready',0,?,?,'1|lexical')`);
  index.run("book-large", chunks, 1);
  const insert = db.prepare("INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES ('book-large',?,?,NULL,NULL)");
  db.transaction(() => {
    for (let ordinal = 0; ordinal < chunks; ordinal += 1) insert.run(ordinal, passageText(ordinal));
  })();
}

const stubRunner: IngestionRunner = {
  run: async (_job: IngestJob): Promise<IngestOutcome> => {
    throw new Error("not used");
  },
  embedQuery: async () => null,
  embeddings: () => ({ mode: "none", model: null, state: "off" }),
  indexVersion: () => "1|lexical",
  onEmbeddingsReady: () => {},
  close: async () => {},
};

function openFileDb(): Db {
  const root = mkdtempSync(join(tmpdir(), "knowlify-chat-loop-"));
  roots.push(root);
  const db = openDb(join(root, "knowlify.db"));
  databases.push(db);
  return db;
}

/**
 * Stopwords plus eight content terms: the worst realistic expression still exercises
 * stopword removal and the strict/OR plan while giving the turn enough matches.
 */
const HEAVY_QUESTION = "the of and to in is that for it as with was on be by this are or from at "
  + "deep work attention focus reading practice memory habit";
/** Never present in the corpus: a sentinel for chat content leaking into logs. */
const SENTINEL = "zebraquantum";

async function turn(chat: Chat, input: ChatTurnInput): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of chat.stream(input, new AbortController().signal)) events.push(event);
  return events;
}

describe("chat retrieval keeps the event loop responsive", () => {
  it(
    "answers a library turn on a large index without blocking the main loop",
    async () => {
      const previous = config.indexing.enabled;
      config.indexing.enabled = true;
      try {
        const db = openFileDb();
        seedLargeIndex(db, CHUNKS);
        const messages: string[] = [];
        const log: Logger = {
          info: (message) => messages.push(message),
          error: (_error, message) => messages.push(message),
          warn: (message) => messages.push(message),
        };
        const services = createServices(db, log, undefined, stubRunner);
        cleanup.push(() => services.searchStore.close());

        const llm = new FakeLlmClient();
        // Long answer with citation markers, so the follow-up also exercises the history
        // cleanup and the anchored retrieval query.
        llm.chunks = [`The author describes deep work [1]. ${"Focus and attention matter. ".repeat(150)}`, " What part would you like to explore?"];
        const fixture = createChatFixture({
          db,
          llm,
          retriever: services.passageSearch,
          limits: { libraryScope: true },
        });

        const monitor = monitorEventLoopDelay({ resolution: 5 });
        monitor.enable();
        let last = performance.now();
        let maxGap = 0;
        const sampler = setInterval(() => {
          const now = performance.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
        }, 5);

        const first = await turn(fixture.chat, { message: `${HEAVY_QUESTION} ${SENTINEL}`, scope: { kind: "library" } });
        const conversationId = first.find((event) => event.type === "sources")?.conversationId;
        expect(conversationId).toBeDefined();
        expect(fixture.conversations.get(conversationId!)?.id).toBe(conversationId);

        const second = await turn(fixture.chat, {
          conversationId,
          message: "The focus part.",
          scope: { kind: "library" },
        });

        clearInterval(sampler);
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        monitor.disable();

        const sources = first.find((event) => event.type === "sources");
        expect(sources).toMatchObject({ type: "sources", retrieval: expect.stringMatching(/hybrid|lexical|semantic/) });
        expect(sources && sources.type === "sources" ? sources.citations.length : 0).toBeGreaterThan(0);
        expect(second.some((event) => event.type === "done")).toBe(true);
        // Diagnosis logs carry fixed messages only: never the question or a passage.
        expect(messages.join("\n")).not.toContain(SENTINEL);

        expect(maxGap).toBeLessThan(LOOP_MAX_MS);
        expect(monitor.max / 1e6).toBeLessThan(LOOP_MAX_MS);
      } finally {
        config.indexing.enabled = previous;
      }
    },
    120_000,
  );

  it("exposes the worker store only for file databases", async () => {
    const memory = openDb(":memory:");
    databases.push(memory);
    const services = createServices(memory, undefined, undefined, stubRunner);
    cleanup.push(() => services.searchStore.close());
    expect(services.searchStore.constructor.name).toBe("SqlitePassageQueryStore");
  });
});
