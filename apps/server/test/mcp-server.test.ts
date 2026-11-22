import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  SqliteBookRepository,
  SqliteNoteRepository,
  SqliteProgressRepository,
} from "../src/adapters/storage/repositories.js";
import { SqliteBookIndexRepository, SqlitePassageRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteTagRepository } from "../src/adapters/storage/SqliteTagRepository.js";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/adapters/mcp/tools/shared.js";
import type { Book } from "../src/ports/index.js";
import type { EmbeddingsStatus, IngestJob, IngestOutcome, IngestSink, IngestionRunner } from "../src/ports/knowledge.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-mcp-server-"));
const original = { ...config, mcp: { ...config.mcp } };
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.mcp.enabled = true;
config.mcp.allowedOrigins = ["https://allowed.example"];
config.mcp.allowedHosts = null;
config.mcp.ratePerMin = 1_000;
config.mcp.writeRatePerMin = 1_000;
config.mcp.authFailurePerMin = 10;

class LexicalRunner implements IngestionRunner {
  status: EmbeddingsStatus = { mode: "none", model: null, state: "off" };
  async run(_job: IngestJob, _sink: IngestSink): Promise<IngestOutcome> { throw new Error("not used"); }
  async embedQuery(): Promise<Float32Array | null> { return null; }
  embeddings(): EmbeddingsStatus { return this.status; }
  indexVersion(): string { return "1|none"; }
  onEmbeddingsReady(): void {}
  async close(): Promise<void> {}
}

const book = (id: string, title: string, author: string, format: Book["format"], path: string): Book => ({
  id, title, author, format, path, cover_path: join(root, "covers", `${id}.jpg`), size: 100,
  added_at: 1_000, source_id: null, mtime: 1, status: "ready",
});

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let readToken = "";
let writeToken = "";
let baseUrl = "";
let externalPath = "";
let externalBefore = "";

const createToken = async (name: string, scope: "read" | "write_notes") => {
  const response = await app.inject({
    method: "POST", url: "/api/mcp/tokens", headers: auth, payload: { name, scope },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { token: string; id: string; name: string };
};

const clientFor = async (token: string, mode: "auto" | "legacy" = "auto"): Promise<Client> => {
  const client = new Client(
    { name: "knowlify-test", version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
};

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args });

const payloadOf = (result: { structuredContent?: unknown }): Record<string, unknown> =>
  (result.structuredContent ?? {}) as Record<string, unknown>;

const errorCode = (payload: Record<string, unknown>): string =>
  ((payload.error ?? {}) as { code?: string }).code ?? "";

const attempt = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  try {
    return await call(client, name, args);
  } catch (error) {
    return error;
  }
};

const isRejected = (value: unknown): boolean =>
  value instanceof Error
  || (typeof value === "object" && value !== null && (value as { isError?: unknown }).isError === true);

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

const raw = async (
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: Number(new URL(baseUrl).port),
      path: "/mcp",
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": String(Buffer.byteLength(payload)),
        ...headers,
      },
    }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
};

const rpc = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
});

const rpcMessages = (response: RawResponse): Array<Record<string, unknown>> => {
  const contentType = String(response.headers["content-type"] ?? "");
  if (!contentType.includes("text/event-stream")) {
    return [JSON.parse(response.text) as Record<string, unknown>];
  }
  return response.text.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
};

beforeAll(async () => {
  await mkdir(join(root, "external"), { recursive: true });
  externalPath = join(root, "external", "pragmatic.pdf");
  externalBefore = "external-file-bytes";
  await writeFile(externalPath, externalBefore);
  db = openDb(join(root, "mcp.db"));
  const books = new SqliteBookRepository(db);
  books.save(book("b1", "The Pragmatic Programmer", "Andrew Hunt", "pdf", externalPath));
  books.save(book("b2", "Clean Code", "Robert Martin", "epub", join(root, "external", "clean.epub")));
  books.save(book("b3", "Zzz Bulk Notes", "Test Author", "pdf", join(root, "external", "bulk.pdf")));
  const indexes = new SqliteBookIndexRepository(db);
  indexes.save({
    bookId: "b1", state: "ready", priority: 0, contentHash: "hash", indexVersion: "1|none", fingerprint: null,
    chunkCount: 2, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
  });
  const passages = new SqlitePassageRepository(db);
  passages.append("b1", [
    { passage: { ordinal: 0, text: "The quick brown fox jumps over the lazy dog", page: 12, section: "Chapter 1" }, vector: null },
    { passage: { ordinal: 1, text: `quick ${"y".repeat(1_200)}`, page: 13, section: null }, vector: null },
  ]);
  const notes = new SqliteNoteRepository(db);
  notes.save({
    id: "n1", book_id: "b1", location: "12", label: "Reader", quote: "quote", body: "Existing note",
    created_at: 1, updated_at: 2,
  });
  // Ten large notes make the payload fit the budget while the serialized response (payload twice) does not.
  for (let index = 0; index < 10; index += 1) {
    notes.save({
      id: `bulk-${index}`, book_id: "b3", location: "", label: "Bulk", quote: "",
      body: `bulk-marker ${index} ${"z".repeat(3_986)}`, created_at: 10 + index, updated_at: 10 + index,
    });
  }
  new SqliteProgressRepository(db).save("b2", { position: "", percentage: 0.5 }, 1_000);
  const tagRepository = new SqliteTagRepository(db);
  tagRepository.create({ id: "tag-focus", name: "Focus", nameKey: "focus", color: "blue", createdAt: 1 });
  tagRepository.apply(["b1"], ["tag-focus"], [], 1, 50);

  ({ app } = await buildApp(db, false, undefined, new LexicalRunner()));
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  readToken = (await createToken("Reader", "read")).token;
  writeToken = (await createToken("Writer", "write_notes")).token;
});

afterAll(async () => {
  await app.close();
  db.close();
  Object.assign(config, original);
  await rm(root, { recursive: true, force: true });
});

describe("MCP protocol and scopes", () => {
  it("serves both eras and never exposes write tools to a read token", async () => {
    const modern = await clientFor(readToken, "auto");
    expect(modern.getProtocolEra()).toBe("modern");
    expect(modern.getInstructions()).toContain("untrusted data");
    const modernTools = (await modern.listTools()).tools.map((tool) => tool.name).sort();
    expect(modernTools).toEqual([...READ_TOOL_NAMES].sort());
    await modern.close();

    const legacy = await clientFor(readToken, "legacy");
    expect(legacy.getProtocolEra()).toBe("legacy");
    expect((await legacy.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    await legacy.close();

    const writer = await clientFor(writeToken, "auto");
    expect((await writer.listTools()).tools.map((tool) => tool.name).sort())
      .toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());
    await writer.close();
  });

  it("refuses write tools with a read token and does not create anything", async () => {
    const client = await clientFor(readToken);
    const before = payloadOf(await call(client, "list_notes", { bookId: "b1" })).notes as unknown[];
    const outcome = await attempt(client, "create_note", { bookId: "b1", body: "must not exist" });
    expect(isRejected(outcome)).toBe(true);
    const after = payloadOf(await call(client, "list_notes", { bookId: "b1" })).notes as unknown[];
    expect(after).toHaveLength(before.length);
    await client.close();
  });

  it("has no destructive tool names", () => {
    for (const name of [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]) {
      expect(name).not.toMatch(/delete|remove_book|merge|rename/iu);
    }
  });
});

describe("MCP read tools", () => {
  it("searches passages with the untrusted-data notice and truncation", async () => {
    const client = await clientFor(readToken);
    const result = await call(client, "search_passages", { query: "quick" });
    const payload = payloadOf(result);
    expect(Object.keys(payload)[0]).toBe("notice");
    expect(payload.notice).toContain("untrusted data");
    expect(payload.mode).toBe("lexical");
    expect(payload.coverage).toEqual({ indexed: 1, total: 3 });
    const hits = payload.hits as Array<{ text: string; page: number }>;
    expect(hits.length).toBe(2);
    expect(hits.some((hit) => hit.text.length === 1_000)).toBe(true);
    expect(payload.truncated).toBe(true);
    const byBook = payloadOf(await call(client, "search_passages", { query: "quick", bookId: "b2" }));
    expect(byBook.hits).toEqual([]);
    await client.close();
  });

  it("lists books with filters, tags, progress and a cursor", async () => {
    const client = await clientFor(readToken);
    const search = payloadOf(await call(client, "list_books", { q: "Pragmatic" }));
    const items = search.items as Array<{ id: string; title: string; indexState: string; tags: unknown[] }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "b1", title: "The Pragmatic Programmer", indexState: "ready" });
    expect(items[0]?.tags).toEqual([{ id: "tag-focus", name: "Focus", color: "blue" }]);

    expect((payloadOf(await call(client, "list_books", { format: "epub" })).items as { id: string }[]).map((item) => item.id))
      .toEqual(["b2"]);
    expect((payloadOf(await call(client, "list_books", { tag: "focus" })).items as { id: string }[]).map((item) => item.id))
      .toEqual(["b1"]);
    expect((payloadOf(await call(client, "list_books", { read: "reading" })).items as { id: string }[]).map((item) => item.id))
      .toEqual(["b2"]);

    const first = payloadOf(await call(client, "list_books", { sort: "title", limit: 1 }));
    expect((first.items as { id: string }[]).map((item) => item.id)).toEqual(["b2"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = payloadOf(await call(client, "list_books", { sort: "title", limit: 1, cursor: first.nextCursor }));
    expect((second.items as { id: string }[]).map((item) => item.id)).toEqual(["b1"]);

    const missing = await call(client, "list_books", { tag: "missing" });
    expect(missing.isError).toBe(true);
    expect(errorCode(payloadOf(missing))).toBe("tag_not_found");
    await client.close();
  });

  it("reads one book without exposing paths or cover paths", async () => {
    const client = await clientFor(readToken);
    const result = await call(client, "get_book", { bookId: "b1" });
    const payload = payloadOf(result);
    expect(payload.notice).toContain("untrusted data");
    expect(payload.book).toMatchObject({ id: "b1", title: "The Pragmatic Programmer", format: "pdf" });
    expect(payload.noteCount).toBe(1);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(config.booksDir);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(externalPath);
    const missing = await call(client, "get_book", { bookId: "missing" });
    expect(missing.isError).toBe(true);
    expect(errorCode(payloadOf(missing))).toBe("not_found");
    await client.close();
  });

  it("lists notes by book and query", async () => {
    const client = await clientFor(readToken);
    const byBook = payloadOf(await call(client, "list_notes", { bookId: "b1" }));
    expect(Object.keys(byBook)[0]).toBe("notice");
    expect((byBook.notes as Array<{ id: string; page: number }>)[0]).toMatchObject({ id: "n1", page: 12 });
    expect((payloadOf(await call(client, "list_notes", { q: "existing" })).notes as unknown[])).toHaveLength(1);
    expect(payloadOf(await call(client, "list_notes", { q: "nothing" })).notes).toEqual([]);
    const missing = await call(client, "list_notes", { bookId: "missing" });
    expect(errorCode(payloadOf(missing))).toBe("not_found");
    await client.close();
  });

  it("reports tags and index status without paths", async () => {
    const client = await clientFor(readToken);
    const tags = payloadOf(await call(client, "list_tags"));
    expect(tags.notice).toContain("untrusted data");
    expect(tags.tags).toEqual([{ id: "tag-focus", name: "Focus", color: "blue", bookCount: 1 }]);
    const status = payloadOf(await call(client, "get_index_status"));
    expect(status.counts).toMatchObject({ ready: 1 });
    expect(status.coverage).toEqual({ indexed: 1, total: 3 });
    expect(JSON.stringify(status)).not.toContain(root);
    await client.close();
  });
});

describe("MCP response limits", () => {
  it("counts the whole serialized JSON-RPC response against the 60 KB ceiling", async () => {
    // The payload alone is under 60 KB; `structuredContent` plus `content.text` doubles it.
    const response = await raw("POST", rpc("list_notes", { bookId: "b3", limit: 50 }), {
      authorization: `Bearer ${readToken}`,
    });
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(response.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
    const [message] = rpcMessages(response);
    const result = message?.result as { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
    expect(result?.isError).toBe(true);
    expect(errorCode(result?.structuredContent ?? {})).toBe("response_too_large");
  });

  it("sets truncated when more notes match than the requested limit", async () => {
    const client = await clientFor(readToken);
    const page = payloadOf(await call(client, "list_notes", { q: "bulk-marker", limit: 2 }));
    expect((page.notes as unknown[]).length).toBe(2);
    expect(page.truncated).toBe(true);

    const exact = payloadOf(await call(client, "list_notes", { q: "bulk-marker 3", limit: 2 }));
    expect((exact.notes as unknown[]).length).toBe(1);
    expect(exact.truncated).toBeUndefined();
    await client.close();
  });

  it("rejects an oversized JSON-RPC id with a bounded error", async () => {
    for (const body of [
      {
        jsonrpc: "2.0",
        id: "x".repeat(70_000),
        method: "tools/call",
        params: { name: "list_tags", arguments: {} },
      },
      [
        { ...rpc("list_tags"), id: 1 },
        { ...rpc("list_tags"), id: "x".repeat(70_000) },
      ],
    ]) {
      const response = await raw("POST", body, { authorization: `Bearer ${readToken}` });
      expect(response.status).toBe(400);
      expect(Buffer.byteLength(response.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
      expect(JSON.parse(response.text)).toMatchObject({
        jsonrpc: "2.0", id: null, error: { code: -32600 },
      });
      expect(response.text).not.toContain("x".repeat(64));
    }
  });

  it("accepts JSON-RPC batches of two to ten messages in request order", async () => {
    const batch = [
      { ...rpc("list_tags"), id: "first" },
      { ...rpc("list_notes", { bookId: "b1" }), id: "second" },
      { ...rpc("get_book", { bookId: "b1" }), id: "third" },
    ];
    const response = await raw("POST", batch, { authorization: `Bearer ${readToken}` });
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(response.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
    const messages = rpcMessages(response);
    expect(messages.map((message) => message.id)).toEqual(["first", "second", "third"]);
    for (const message of messages) {
      expect(message.error).toBeUndefined();
      expect((message.result as { content?: unknown[] }).content).toHaveLength(1);
    }

    const ten = Array.from({ length: 10 }, (_, index) => ({ ...rpc("list_tags"), id: `ten-${index}` }));
    const accepted = await raw("POST", ten, { authorization: `Bearer ${readToken}` });
    expect(accepted.status).toBe(200);
    expect(Buffer.byteLength(accepted.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
    expect(rpcMessages(accepted).map((message) => message.id)).toEqual(ten.map((message) => message.id));
  });

  it("rejects empty batches and batches above ten messages", async () => {
    const empty = await raw("POST", [], { authorization: `Bearer ${readToken}` });
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.text)).toMatchObject({ id: null, error: { code: -32600 } });

    const eleven = Array.from({ length: 11 }, (_, index) => ({ ...rpc("list_tags"), id: index + 1 }));
    const response = await raw("POST", eleven, { authorization: `Bearer ${readToken}` });
    expect(response.status).toBe(400);
    expect(Buffer.byteLength(response.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
    expect(JSON.parse(response.text)).toMatchObject({
      jsonrpc: "2.0", id: null, error: { code: -32600 },
    });
    expect(response.text).toContain("10 messages");
  });

  it("answers 202 to a notification-only batch", async () => {
    const response = await raw("POST", [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "done" } },
    ], { authorization: `Bearer ${readToken}` });
    expect(response.status).toBe(202);
    expect(response.text).toBe("");
  });

  it("applies the token scope to each batch item", async () => {
    const client = await clientFor(readToken);
    const before = payloadOf(await call(client, "list_notes", { bookId: "b1" })).notes as Array<{ body: string }>;
    const response = await raw("POST", [
      { ...rpc("list_tags"), id: "read" },
      { ...rpc("create_note", { bookId: "b1", body: "batch must not exist" }), id: "write" },
    ], { authorization: `Bearer ${readToken}` });
    expect(response.status).toBe(200);
    const messages = rpcMessages(response);
    expect(messages.map((message) => message.id)).toEqual(["read", "write"]);
    expect(messages[0]?.result).toBeDefined();
    expect(messages[0]?.error).toBeUndefined();
    const denied = messages[1]!;
    const refused = denied.error !== undefined || (denied.result as { isError?: boolean } | undefined)?.isError === true;
    expect(refused).toBe(true);

    const after = payloadOf(await call(client, "list_notes", { bookId: "b1" })).notes as Array<{ body: string }>;
    expect(after).toHaveLength(before.length);
    expect(after.some((note) => note.body.includes("batch must not exist"))).toBe(false);
    await client.close();
  });

  it("degrades batch items that no longer fit the shared response ceiling", async () => {
    // Each list_notes result is ~24 KB serialized; four items exceed 60 KB together.
    const batch = [1, 2, 3, 4].map((id) => ({ ...rpc("list_notes", { bookId: "b3", limit: 3 }), id }));
    const response = await raw("POST", batch, { authorization: `Bearer ${readToken}` });
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(response.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
    const messages = rpcMessages(response);
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3, 4]);
    expect(messages[0]?.result).toBeDefined();
    expect(messages[1]?.result).toBeDefined();
    for (const message of messages.slice(2)) {
      expect(message.result).toBeUndefined();
      expect(message.error).toMatchObject({ code: -32603, data: { code: "response_too_large" } });
    }
    // Every item is still complete JSON: parseable messages, no truncated frame.
    expect(messages.every((message) => message.jsonrpc === "2.0")).toBe(true);
  });

  it("accepts a single-element batch and still bounds it", async () => {
    const single = await raw("POST", [{ ...rpc("list_tags"), id: 9 }], {
      authorization: `Bearer ${readToken}`,
    });
    expect(single.status).toBe(200);
    expect(Buffer.byteLength(single.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
    const [message] = rpcMessages(single);
    expect((message?.result as { content?: unknown } | undefined)?.content).toBeDefined();

    // The one-element batch keeps its array shape when its response is replaced.
    const oversized = await raw("POST", [{
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "x".repeat(70_000), arguments: {} },
    }], { authorization: `Bearer ${readToken}` });
    expect(oversized.status).toBe(200);
    expect(Buffer.byteLength(oversized.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
    const [replaced] = rpcMessages(oversized);
    expect(replaced).toMatchObject({ id: 13, error: { code: -32603, data: { code: "response_too_large" } } });
  });

  it("bounds SDK errors that echo request input", async () => {
    const response = await raw("POST", {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "x".repeat(70_000), arguments: {} },
    }, { authorization: `Bearer ${readToken}` });
    expect(response.status).toBe(500);
    expect(Buffer.byteLength(response.text, "utf8")).toBeLessThanOrEqual(config.mcp.maxResponseBytes);
    const [message] = rpcMessages(response);
    expect(message).toMatchObject({ jsonrpc: "2.0", id: 12, error: { code: -32603 } });
    expect(response.text).not.toContain("x".repeat(64));
  });
});

describe("MCP write tools", () => {
  it("creates notes with the token name as label and keeps external files untouched", async () => {
    const client = await clientFor(writeToken);
    const created = payloadOf(await call(client, "create_note", {
      bookId: "b1", body: "MCP note", quote: "quoted", page: 42,
    }));
    expect(created.id).toEqual(expect.any(String));
    const notes = payloadOf(await call(client, "list_notes", { bookId: "b1" })).notes as Array<{
      id: string; label: string; page?: number; body: string;
    }>;
    expect(notes.find((note) => note.id === created.id)).toMatchObject({
      label: "Writer", page: 42, body: "MCP note",
    });
    const epub = payloadOf(await call(client, "create_note", { bookId: "b2", body: "EPUB note", page: 7 }));
    const epubNotes = payloadOf(await call(client, "list_notes", { bookId: "b2" })).notes as Array<{ id: string; page?: number }>;
    expect(epubNotes.find((note) => note.id === epub.id)?.page).toBeUndefined();
    // The 2025 era goes through the stateless fallback; authInfo must still reach the tool.
    const legacy = await clientFor(writeToken, "legacy");
    const legacyNote = payloadOf(await call(legacy, "create_note", { bookId: "b1", body: "Legacy note" }));
    const legacyNotes = payloadOf(await call(legacy, "list_notes", { bookId: "b1" })).notes as Array<{
      id: string; label: string;
    }>;
    expect(legacyNotes.find((note) => note.id === legacyNote.id)?.label).toBe("Writer");
    await legacy.close();
    expect(await readFile(externalPath, "utf8")).toBe(externalBefore);
    await client.close();
  });

  it("sets favorites and exposes them in list_books and get_book", async () => {
    const writer = await clientFor(writeToken);
    expect(payloadOf(await call(writer, "set_book_favorite", { bookId: "b2", favorite: true })))
      .toMatchObject({ bookId: "b2", favorite: true });

    const favorites = payloadOf(await call(writer, "list_books", { favorite: true }));
    expect((favorites.items as Array<{ id: string; favorite: boolean }>))
      .toEqual([expect.objectContaining({ id: "b2", favorite: true })]);
    expect(favorites.total).toBe(1);
    expect(payloadOf(await call(writer, "get_book", { bookId: "b2" })).book)
      .toMatchObject({ id: "b2", favorite: true });

    const missing = await call(writer, "set_book_favorite", { bookId: "missing", favorite: true });
    expect(missing.isError).toBe(true);
    expect(errorCode(payloadOf(missing))).toBe("not_found");

    // The read handler never registers the tool, and a read token keeps seeing the flag.
    const reader = await clientFor(readToken);
    expect(isRejected(await attempt(reader, "set_book_favorite", { bookId: "b2", favorite: false }))).toBe(true);
    expect((payloadOf(await call(reader, "list_books", { q: "Clean Code" })).items as Array<{ favorite: boolean }>)[0])
      .toMatchObject({ favorite: true });

    await call(writer, "set_book_favorite", { bookId: "b2", favorite: false });
    expect(payloadOf(await call(writer, "list_books", { favorite: true })).items).toEqual([]);
    await reader.close();
    await writer.close();
  });

  it("adds and removes tags by name in one batch", async () => {
    const client = await clientFor(writeToken);
    const added = payloadOf(await call(client, "add_tags_to_books", {
      bookIds: ["b1", "b2"], tags: ["Focus", "MCP Tag"],
    }));
    expect(added).toMatchObject({ matched: 2, added: 3, createdTags: ["MCP Tag"] });
    const tags = payloadOf(await call(client, "list_tags")).tags as Array<{ name: string; color: string; bookCount: number }>;
    expect(tags.find((tag) => tag.name === "MCP Tag")).toMatchObject({ color: "gray", bookCount: 2 });

    const removed = payloadOf(await call(client, "remove_tags_from_books", {
      bookIds: ["b1"], tags: ["mcp tag"],
    }));
    expect(removed).toEqual({ matched: 1, removed: 1 });
    expect((payloadOf(await call(client, "list_tags")).tags as Array<{ name: string; bookCount: number }>)
      .find((tag) => tag.name === "MCP Tag")?.bookCount).toBe(1);

    const missing = await call(client, "remove_tags_from_books", { bookIds: ["b1"], tags: ["Missing"] });
    expect(missing.isError).toBe(true);
    expect(errorCode(payloadOf(missing))).toBe("tag_not_found");
    await client.close();
  });
});

describe("MCP transport security", () => {
  it("rejects missing, malformed and unknown tokens with a generic 401", async () => {
    const basic = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`;
    for (const authorization of [undefined, "Bearer", "Bearer nope", `Bearer ${readToken.slice(0, -1)}x`, basic]) {
      const response = await raw("POST", rpc("list_tags"), authorization === undefined ? {} : { authorization });
      expect(response.status).toBe(401);
      expect(response.text).not.toContain("knw_mcp_");
      expect(String(response.headers["www-authenticate"])).toContain("Bearer");
    }
  });

  it("enforces the Origin allowlist and disables CORS on /mcp", async () => {
    const blocked = await raw("POST", rpc("list_tags"), { authorization: `Bearer ${readToken}`, origin: "https://evil.example" });
    expect(blocked.status).toBe(403);
    const allowed = await raw("POST", rpc("list_tags"), { authorization: `Bearer ${readToken}`, origin: "https://allowed.example" });
    expect(allowed.status).toBe(200);
    const preflight = await raw("OPTIONS", undefined, {
      authorization: `Bearer ${readToken}`,
      origin: "https://allowed.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("checks Host only when a list is configured", async () => {
    const previous = config.mcp.allowedHosts;
    config.mcp.allowedHosts = ["allowed.test"];
    try {
      const blocked = await raw("POST", rpc("list_tags"), { authorization: `Bearer ${readToken}`, host: "evil.test" });
      expect(blocked.status).toBe(403);
      const allowed = await raw("POST", rpc("list_tags"), { authorization: `Bearer ${readToken}`, host: "allowed.test" });
      expect(allowed.status).toBe(200);
    } finally {
      config.mcp.allowedHosts = previous;
    }
  });

  it("answers 405 for GET/DELETE and 413 above the body limit", async () => {
    expect((await raw("GET", undefined, { authorization: `Bearer ${readToken}` })).status).toBe(405);
    expect((await raw("DELETE", undefined, { authorization: `Bearer ${readToken}` })).status).toBe(405);
    const big = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_tags", arguments: { pad: "x".repeat(300 * 1_024) } } };
    expect((await raw("POST", big, { authorization: `Bearer ${readToken}` })).status).toBe(413);
  });

  it("revokes access immediately", async () => {
    const token = await createToken("Revoked", "read");
    const client = await clientFor(token.token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "DELETE", url: `/api/mcp/tokens/${token.id}`, headers: auth })).statusCode).toBe(204);
    const outcome = await attempt(client, "list_tags");
    expect(outcome instanceof Error).toBe(true);
    await client.close();
  });

  it("logs usage without arguments, queries or note text", async () => {
    const spy = vi.spyOn(app.log, "info").mockImplementation(() => {});
    try {
      const client = await clientFor(writeToken);
      const marker = "LOG_MARKER_DO_NOT_PERSIST";
      await call(client, "create_note", { bookId: "b1", body: `${marker} body`, quote: `${marker} quote` });
      await client.close();
      const lines = spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("mcp_call"));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const line of lines) {
        expect(line).not.toContain(marker);
        expect(line).not.toContain("body");
      }
      const line = lines.find((candidate) => JSON.parse(candidate).tool === "create_note");
      expect(line).toBeDefined();
      expect(JSON.parse(line!)).toMatchObject({
        event: "mcp_call",
        tokenId: expect.any(String),
        scope: "write_notes",
        tool: "create_note",
        ok: true,
        resultCount: 1,
      });
      expect(line).not.toContain("knw_mcp_");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("MCP rate limits and disabled mode", () => {
  it("limits tools/call per token, writes per token and auth failures per IP", async () => {
    const rateRoot = await mkdtemp(join(tmpdir(), "knowlify-mcp-rate-"));
    const previous = { ...config, mcp: { ...config.mcp } };
    config.dataDir = rateRoot;
    config.booksDir = join(rateRoot, "books");
    config.coversDir = join(rateRoot, "covers");
    config.mcp.ratePerMin = 2;
    config.mcp.writeRatePerMin = 1;
    config.mcp.authFailurePerMin = 2;
    const rateDb = openDb(join(rateRoot, "rate.db"));
    const rateApp = await buildApp(rateDb).then((value) => value.app);
    try {
      await rateApp.ready();
      const basic = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
      const createTokenFor = async (name: string) => (await rateApp.inject({
        method: "POST", url: "/api/mcp/tokens", headers: basic, payload: { name, scope: "write_notes" },
      })).json().token as string;
      const readRateToken = await createTokenFor("Rate read");
      const writeRateToken = await createTokenFor("Rate write");
      await rateApp.listen({ port: 0, host: "127.0.0.1" });
      const address = rateApp.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const send = async (body: unknown, authHeader: string) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = httpRequest({
          host: "127.0.0.1", port, path: "/mcp", method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: authHeader, "content-length": String(Buffer.byteLength(payload)) },
        }, (response) => { response.resume(); response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers })); });
        req.on("error", reject);
        req.end(payload);
      });
      expect((await send(rpc("list_tags"), `Bearer ${readRateToken}`)).status).toBe(200);
      expect((await send(rpc("list_tags"), `Bearer ${readRateToken}`)).status).toBe(200);
      const limited = await send(rpc("list_tags"), `Bearer ${readRateToken}`);
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();

      // A separate token exercises the lower write ceiling; the first call reaches the tool.
      expect((await send(rpc("create_note", { bookId: "missing", body: "x" }), `Bearer ${writeRateToken}`)).status).toBe(200);
      expect((await send(rpc("create_note", { bookId: "missing", body: "x" }), `Bearer ${writeRateToken}`)).status).toBe(429);
      const favoriteRateToken = await createTokenFor("Rate favorite");
      expect((await send(rpc("set_book_favorite", { bookId: "missing", favorite: true }), `Bearer ${favoriteRateToken}`)).status).toBe(200);
      expect((await send(rpc("set_book_favorite", { bookId: "missing", favorite: true }), `Bearer ${favoriteRateToken}`)).status).toBe(429);

      // Each batch message consumes the token rate, and each write inside a batch
      // consumes the write rate, so a batch cannot multiply the allowance.
      const batchReadToken = await createTokenFor("Rate batch read");
      expect((await send([
        { ...rpc("list_tags"), id: 1 },
        { ...rpc("list_tags"), id: 2 },
      ], `Bearer ${batchReadToken}`)).status).toBe(200);
      expect((await send(rpc("list_tags"), `Bearer ${batchReadToken}`)).status).toBe(429);

      const batchWriteToken = await createTokenFor("Rate batch write");
      expect((await send([
        { ...rpc("create_note", { bookId: "missing", body: "x" }), id: 1 },
        { ...rpc("create_note", { bookId: "missing", body: "y" }), id: 2 },
      ], `Bearer ${batchWriteToken}`)).status).toBe(429);

      expect((await send(rpc("list_tags"), "Bearer bad-1")).status).toBe(401);
      expect((await send(rpc("list_tags"), "Bearer bad-2")).status).toBe(401);
      expect((await send(rpc("list_tags"), "Bearer bad-3")).status).toBe(429);
    } finally {
      await rateApp.close();
      rateDb.close();
      Object.assign(config, previous);
      await rm(rateRoot, { recursive: true, force: true });
    }
  });

  it("returns 404 for the MCP route and mcp_disabled for creation when off", async () => {
    const offRoot = await mkdtemp(join(tmpdir(), "knowlify-mcp-off-"));
    const previous = { ...config, mcp: { ...config.mcp } };
    config.dataDir = offRoot;
    config.booksDir = join(offRoot, "books");
    config.coversDir = join(offRoot, "covers");
    config.mcp.enabled = false;
    const offDb = openDb(join(offRoot, "off.db"));
    const { app: offApp } = await buildApp(offDb);
    try {
      await offApp.ready();
      await offApp.listen({ port: 0, host: "127.0.0.1" });
      const address = offApp.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const post = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
      expect(post.status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/mcp`)).status).toBe(404);
      const basic = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
      const tokens = await offApp.inject({ method: "GET", url: "/api/mcp/tokens", headers: basic });
      expect(tokens.json()).toMatchObject({ enabled: false, path: "/mcp", items: [] });
      const create = await offApp.inject({ method: "POST", url: "/api/mcp/tokens", headers: basic, payload: { name: "x", scope: "read" } });
      expect(create.statusCode).toBe(404);
      expect(create.json()).toMatchObject({ code: "mcp_disabled" });
    } finally {
      await offApp.close();
      offDb.close();
      Object.assign(config, previous);
      await rm(offRoot, { recursive: true, force: true });
    }
  });

  it("returns a clear tool error when indexing is disabled", async () => {
    const offRoot = await mkdtemp(join(tmpdir(), "knowlify-mcp-index-off-"));
    const previous = { ...config, mcp: { ...config.mcp } };
    config.dataDir = offRoot;
    config.booksDir = join(offRoot, "books");
    config.coversDir = join(offRoot, "covers");
    config.mcp.enabled = true;
    config.mcp.allowedHosts = null;
    config.mcp.allowedOrigins = [];
    const offDb = openDb(join(offRoot, "index-off.db"));
    const { app: offApp } = await buildApp(offDb);
    try {
      await offApp.ready();
      const basic = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
      const token = (await offApp.inject({
        method: "POST", url: "/api/mcp/tokens", headers: basic, payload: { name: "Index", scope: "read" },
      })).json().token as string;
      await offApp.listen({ port: 0, host: "127.0.0.1" });
      const address = offApp.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const client = new Client({ name: "index-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      const result = await call(client, "search_passages", { query: "anything" });
      expect(result.isError).toBe(true);
      expect(payloadOf(result).error).toMatchObject({ code: "indexing_disabled" });
      await client.close();
    } finally {
      await offApp.close();
      offDb.close();
      Object.assign(config, previous);
      await rm(offRoot, { recursive: true, force: true });
    }
  });
});
