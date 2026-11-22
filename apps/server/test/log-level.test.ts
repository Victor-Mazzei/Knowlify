import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { MetadataCache } from "../src/adapters/metadata/MetadataCache.js";
import { observedFetch } from "../src/adapters/outboundDebug.js";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/SqliteBookRepository.js";
import { config, LOG_LEVELS, readLogLevel } from "../src/config.js";
import { buildApp, REDACT_PATHS } from "../src/index.js";
import { MetadataLookup } from "../src/use-cases/MetadataLookup.js";
import type { Logger } from "../src/ports/index.js";
import type { MetadataProvider } from "../src/ports/library-metadata.js";
import type { Book } from "../src/ports/index.js";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>["app"]> = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const loggerFor = (
  app: Awaited<ReturnType<typeof buildApp>>["app"],
): Logger => ({
  info: (message) => app.log.info(message),
  error: (error, message) => app.log.error(error, message),
  warn: (message) => app.log.warn(message),
  debug: (message) => app.log.debug(message),
});

async function appAt(
  level: (typeof LOG_LEVELS)[number],
  seed?: (db: Db) => void,
  setup?: (app: Awaited<ReturnType<typeof buildApp>>["app"]) => void,
): Promise<{ app: Awaited<ReturnType<typeof buildApp>>["app"]; db: Db; output: () => string }> {
  const root = await mkdtemp(join(tmpdir(), "knowlify-log-level-"));
  roots.push(root);
  config.dataDir = root;
  config.booksDir = join(root, "books");
  config.coversDir = join(root, "covers");
  config.logLevel = level;
  const db = openDb(join(root, "log.db"));
  seed?.(db);
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const { app } = await buildApp(db, { stream });
  setup?.(app);
  await app.ready();
  apps.push(app);
  return { app, db, output: () => chunks.join("") };
}

const book = (id: string): Book => ({
  id,
  title: "A book",
  author: "An author",
  format: "epub",
  path: `/library/${id}.epub`,
  cover_path: `/covers/${id}.jpg`,
  size: 10,
  added_at: 1,
  source_id: null,
  mtime: 1,
  status: "ready",
});

describe("KNOWLIFY_LOG_LEVEL", () => {
  it("defaults to info, is case-insensitive and rejects unknown values listing the valid ones", () => {
    expect(readLogLevel(undefined)).toBe("info");
    expect(readLogLevel("")).toBe("info");
    expect(readLogLevel("  ")).toBe("info");
    expect(readLogLevel("DEBUG")).toBe("debug");
    for (const level of LOG_LEVELS) expect(readLogLevel(level)).toBe(level);
    let message = "";
    try {
      readLogLevel("verbose");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("error, warn, info, debug, trace, silent");
    expect(message).not.toContain("verbose");
  });

  it("kills the boot with a clear message for an invalid level", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowlify-log-boot-"));
    roots.push(root);
    const serverRoot = fileURLToPath(new URL("..", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: serverRoot,
      env: { ...process.env, KNOWLIFY_LOG_LEVEL: "verbose", KNOWLIFY_DATA: join(root, "data"), PORT: "0" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("KNOWLIFY_LOG_LEVEL must be one of: error, warn, info, debug, trace, silent");
    expect(`${result.stderr}${result.stdout}`).not.toContain("verbose");
  });

  it("emits the boot level and filters debug at the default info level", async () => {
    const { app, output } = await appAt("info");
    app.log.debug("debug-sentinel");
    app.log.info("info-sentinel");
    const text = output();
    expect(text).toContain("log level: info");
    expect(text).toContain("info-sentinel");
    expect(text).not.toContain("debug-sentinel");
    expect(text).not.toContain("database schema version");
    expect(text).not.toContain('"level":20');
  });

  it("emits debug events and the schema version when debug is enabled", async () => {
    const { app, output } = await appAt("debug");
    app.log.debug("debug-sentinel");
    const log = loggerFor(app);
    const debug: string[] = [];
    const fetchFn = observedFetch(async () => new Response("{}"), "metadata", {
      ...log,
      debug: (message) => { debug.push(message); log.debug?.(message); },
    });
    await fetchFn("https://www.googleapis.com/books/v1/volumes?q=isbn:9780132350884&key=secret");
    const text = output();
    expect(text).toContain("debug-sentinel");
    expect(text).toContain("database schema version");
    expect(debug[0]).toContain("provider=metadata");
    expect(debug[0]).toContain("path=/books/v1/volumes");
    expect(text).not.toContain("9780132350884");
    expect(text).not.toContain("key=secret");
  });

  it("emits nothing at silent", async () => {
    const { app, output } = await appAt("silent");
    app.log.info("info-sentinel");
    app.log.debug("debug-sentinel");
    await app.inject({ method: "GET", url: "/health" });
    expect(output()).toBe("");
  });
});

describe("logger redaction", () => {
  it("drops query strings from request lines and redacts sensitive fields", async () => {
    const { app, output } = await appAt("debug");
    const headerSecret = "HEADER-AUTH-SENTINEL";
    const cookieSecret = "COOKIE-SENTINEL";
    app.log.warn({
      req: {
        method: "GET",
        url: "/api/books?q=ISBN-SENTINEL&author=AUTHOR-SENTINEL",
        hostname: "localhost",
        ip: "127.0.0.1",
        headers: { authorization: `Basic ${headerSecret}`, cookie: `sid=${cookieSecret}` },
        body: { password: "PASSWORD-SENTINEL", apiKey: "KEY-SENTINEL" },
      },
      res: { headers: { "set-cookie": `sid=${cookieSecret}` } },
    }, "redact-probe");
    const text = output();
    expect(text).toContain("redact-probe");
    expect(text).toContain('"method":"GET"');
    expect(text).not.toContain("/api/books");
    for (const sentinel of [headerSecret, cookieSecret, "ISBN-SENTINEL", "AUTHOR-SENTINEL", "PASSWORD-SENTINEL", "KEY-SENTINEL"]) {
      expect(text).not.toContain(sentinel);
    }

    // Pino redaction, exercised with the same paths the server configures.
    const chunks: string[] = [];
    const logger = pino({ redact: REDACT_PATHS }, new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }));
    logger.warn({
      req: { headers: { authorization: `Basic ${headerSecret}`, cookie: `sid=${cookieSecret}` }, body: { apiKey: "KEY-SENTINEL" } },
      res: { headers: { "set-cookie": `sid=${cookieSecret}` } },
    }, "pino-redact-probe");
    const redacted = chunks.join("");
    expect(redacted).toContain("[Redacted]");
    for (const sentinel of [headerSecret, cookieSecret, "KEY-SENTINEL"]) {
      expect(redacted).not.toContain(sentinel);
    }
  });

  it("never logs sentinels across metadata, auth, notes, MCP and chat at trace", async () => {
    const ISBN = "9780132350884";
    const TITLE = "TITLE-SENTINEL";
    const GOOGLE_KEY = "GOOGLE-KEY-SENTINEL";
    const LLM_KEY = "LLM-KEY-SENTINEL";
    const LLM_HEADER = "LLM-HEADER-VALUE-SENTINEL";
    const QUESTION = "QUESTION-SENTINEL";
    const ANSWER = "ANSWER-SENTINEL";
    const NOTE = "NOTE-BODY-SENTINEL";
    const QUOTE = "NOTE-QUOTE-SENTINEL";
    const PASSAGE = "PASSAGE-SENTINEL";
    const PASSWORD = "PASSWORD-SENTINEL";
    const NEXT_PASSWORD = "NEXT-PASSWORD-SENTINEL";
    const BASIC_SECRET = "BASIC-AUTH-SENTINEL";
    const MCP_ARGUMENT = "MCP-ARGUMENT-SENTINEL";

    const llmServer = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    servers.push(llmServer);
    const llmPort = (llmServer.address() as AddressInfo).port;

    const previous = {
      llm: { ...config.llm, headers: config.llm.headers },
      logLevel: config.logLevel,
      mcp: { ...config.mcp },
    };
    config.llm.url = `http://127.0.0.1:${llmPort}/v1`;
    config.llm.apiKey = LLM_KEY;
    config.llm.model = "test-model";
    config.llm.headers = [{ name: "X-Session-Id", value: LLM_HEADER }];
    config.mcp.enabled = true;
    config.mcp.ratePerMin = 1_000;
    config.mcp.writeRatePerMin = 1_000;

    try {
      const { app, output } = await appAt("trace", (db) => {
        new SqliteBookRepository(db).save(book("b1"));
      });
      const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

      // Basic auth failure: the header never reaches the log.
      await app.inject({
        method: "GET",
        url: "/api/books",
        headers: { authorization: `Basic ${Buffer.from(`admin:${BASIC_SECRET}`).toString("base64")}` },
      });
      // Missing credentials and the KOSync scheme get their own categories.
      await app.inject({ method: "GET", url: "/api/books" });
      await app.inject({ method: "GET", url: "/kosync/users/auth" });

      // Note body/quote.
      const note = await app.inject({
        method: "POST",
        url: "/api/books/b1/notes",
        headers: auth,
        payload: { body: NOTE, quote: QUOTE, location: "1" },
      });
      expect(note.statusCode).toBe(201);

      // Search text (ISBN and title) and the provider message never reach the log.
      let providerCalls = 0;
      const failingProvider: MetadataProvider = {
        id: "googlebooks",
        keyConfigured: true,
        search: async () => {
          providerCalls += 1;
          throw new Error(`provider failed for ${ISBN} ${TITLE} ${GOOGLE_KEY} https://example.test/?q=${ISBN}`);
        },
      };
      const lookup = new MetadataLookup([failingProvider], new MetadataCache(), { enabled: true });
      await lookup.search({ isbn: ISBN }, loggerFor(app));
      await lookup.search({ title: TITLE, author: "AUTHOR-SENTINEL" }, loggerFor(app));
      expect(providerCalls).toBe(2);

      // Chat question, answer, key and custom header value.
      const chat = await app.inject({
        method: "POST",
        url: "/api/chat/messages",
        headers: auth,
        payload: {
          message: QUESTION,
          scope: { kind: "book", bookId: "b1", excerpt: PASSAGE, excerptKind: "selection" },
        },
      });
      expect([200, 204]).toContain(chat.statusCode);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // MCP: tool name is logged, arguments and the clear token are not.
      const created = await app.inject({
        method: "POST",
        url: "/api/mcp/tokens",
        headers: auth,
        payload: { name: "sweep", scope: "write_notes" },
      });
      expect(created.statusCode).toBe(201);
      const token = (created.json() as { token: string }).token;
      const rpc = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_note", arguments: { bookId: "b1", body: MCP_ARGUMENT } },
      };
      const mcp = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: rpc,
      });
      expect([200, 202]).toContain(mcp.statusCode);

      // A revoked token is a 401 with a distinct debug category, never the token.
      const tokenId = (created.json() as { id: string }).id;
      await app.inject({ method: "DELETE", url: `/api/mcp/tokens/${tokenId}`, headers: auth });
      await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: rpc,
      });

      // A read token attempting a write tool logs the scope mismatch, not the arguments.
      const read = await app.inject({
        method: "POST",
        url: "/api/mcp/tokens",
        headers: auth,
        payload: { name: "sweep-read", scope: "read" },
      });
      const readToken = (read.json() as { token: string }).token;
      await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${readToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: rpc,
      });

      // Password change failure: both fields stay out of the log.
      await app.inject({
        method: "POST",
        url: "/api/account/password",
        headers: { authorization: `Basic ${Buffer.from(`admin:${BASIC_SECRET}`).toString("base64")}` },
        payload: { current: PASSWORD, next: NEXT_PASSWORD },
      });

      // The tool/scope event carries the name and scope only.
      const text = output();
      expect(text).toContain("mcp_call");
      expect(text).toContain("create_note");
      expect(text).toContain("write_notes");
      expect(text).toContain("reason=token_revoked");
      expect(text).toContain("auth failed provider=kosync ip=127.0.0.1 reason=credentials_missing");
      expect(text).toContain("mcp scope rejected ip=127.0.0.1 scope=read");
      const forbidden = [
        ISBN, TITLE, GOOGLE_KEY, LLM_KEY, LLM_HEADER, QUESTION, ANSWER, NOTE, QUOTE,
        PASSAGE, PASSWORD, NEXT_PASSWORD, BASIC_SECRET, MCP_ARGUMENT, token, readToken,
      ];
      for (const sentinel of forbidden) {
        expect(text, `leaked ${sentinel}`).not.toContain(sentinel);
      }
      expect(text).not.toMatch(/Authorization:\s/iu);
      expect(text).not.toContain("data: ");
      expect(text).not.toContain("knw_mcp_");
    } finally {
      Object.assign(config.llm, previous.llm);
      config.llm.headers = previous.llm.headers;
      config.logLevel = previous.logLevel;
      Object.assign(config.mcp, previous.mcp);
    }
  });

  it("keeps the logger silent for a successful request at silent and logs it at debug", async () => {
    const silent = await appAt("silent");
    await silent.app.inject({ method: "GET", url: "/health" });
    expect(silent.output()).toBe("");

    const debug = await appAt("debug");
    await debug.app.inject({ method: "GET", url: "/health" });
    expect(debug.output()).toContain('"msg":"incoming request"');
  });
});

describe("safe error and request logging", () => {
  it("never logs exception content, arbitrary paths or hostile hostnames at any level", async () => {
    const causeToken = "SENTINEL_CAUSE_SECRET";
    const errorName = "SENTINEL_ERROR_NAME";
    const errorCode = "SENTINEL_ERROR_CODE";
    const pathToken = "SENTINEL_PATH_SECRET";
    const hostToken = "SENTINEL_HOST_SECRET";
    const queryToken = "SENTINEL_QUERY_SECRET";
    const sentinels = [causeToken, errorName, errorCode, pathToken, hostToken, queryToken];
    const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

    const hostileError = (): Error => {
      const error = new Error(`provider failed https://example.org/?token=${causeToken}`, {
        cause: new Error(`https://example.org/?token=${causeToken}`),
      });
      error.name = errorName;
      (error as Error & { code?: string }).code = errorCode;
      return error;
    };

    for (const level of LOG_LEVELS) {
      const { app, output } = await appAt(level, undefined, (app) => {
        app.get("/log-error", async (req) => {
          req.log.error(hostileError(), "request failure");
          return { ok: true };
        });
      });

      app.log.error(hostileError(), "failure");
      const logged = await app.inject({ method: "GET", url: "/log-error", headers: auth });
      expect(logged.statusCode).toBe(200);

      const notFound = await app.inject({
        method: "GET",
        url: `/${pathToken}?q=${queryToken}`,
      });
      expect(notFound.statusCode).toBe(404);
      // The HTTP contract is unchanged; only the logs are sanitized.
      expect(notFound.body).toContain(pathToken);

      const outbound = observedFetch(async () => new Response("{}"), "rss", loggerFor(app));
      const response = await outbound(`https://${hostToken}.example.com/${pathToken}?token=${queryToken}`);
      await response.body?.cancel();

      const text = output();
      for (const sentinel of sentinels) {
        expect(text, `${level} leaked ${sentinel}`).not.toContain(sentinel);
      }
      if (level === "silent") {
        expect(text).toBe("");
        continue;
      }
      expect(text).toContain('"msg":"failure"');
      expect(text).toContain('"msg":"request failure"');
      expect(text).toContain('"type":"Error"');
      if (level === "debug" || level === "trace") {
        expect(text).toContain("host=external");
      }
      if (level === "info" || level === "debug" || level === "trace") {
        expect(text).toContain('"msg":"incoming request"');
        expect(text).toContain('"msg":"route not found"');
      }
    }
  });
});
