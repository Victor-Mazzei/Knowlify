import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/adapters/storage/db.js";
import { config, LOG_LEVELS } from "../src/config.js";
import { buildApp } from "../src/index.js";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>["app"]> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type TestApp = {
  app: Awaited<ReturnType<typeof buildApp>>["app"];
  output: () => string;
};

async function appAt(level: (typeof LOG_LEVELS)[number]): Promise<TestApp> {
  const root = await mkdtemp(join(tmpdir(), "knowlify-log-redact-"));
  roots.push(root);
  config.dataDir = root;
  config.booksDir = join(root, "books");
  config.coversDir = join(root, "covers");
  config.logLevel = level;
  const db = openDb(":memory:");
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const { app } = await buildApp(db, { stream });
  await app.ready();
  apps.push(app);
  return { app, output: () => chunks.join("") };
}

const basic = (password: string): string =>
  `Basic ${Buffer.from(`${config.user}:${password}`).toString("base64")}`;

/** Minimal EPUB that the inline metadata extractor accepts, so the upload returns 201. */
const epub = (title: string): Buffer => {
  const zip = new AdmZip();
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
  );
  zip.addFile(
    "book.opf",
    Buffer.from(
      `<package><metadata><title>${title}</title><creator>Author</creator></metadata><manifest></manifest></package>`,
    ),
  );
  return zip.toBuffer();
};

const multipartBody = (bytes: Buffer): { payload: Buffer; contentType: string } => {
  const boundary = `knowlify-${createHash("md5").update(bytes).digest("hex")}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sensitive.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
};

const upload = (
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  bytes: Buffer,
  headers: Record<string, string>,
) => {
  const { payload, contentType } = multipartBody(bytes);
  return app.inject({
    method: "POST",
    url: "/api/books",
    headers: { ...headers, "content-type": contentType },
    payload,
  });
};

describe("header redaction", () => {
  it("censors the multipart busboy headers at trace and keeps the request line useful", async () => {
    const { app, output } = await appAt("trace");
    const password = config.password;
    const passwordEncoded = Buffer.from(`${config.user}:${password}`).toString("base64");
    const hostSentinel = "HOST-SENTINEL.test";
    const cookieSentinel = "COOKIE-SENTINEL";
    const originSentinel = "http://ORIGIN-SENTINEL.test";
    const refererSentinel = "http://REFERER-SENTINEL.test/path";
    const fileSentinel = "FILE-CONTENT-SENTINEL";

    const response = await upload(app, epub(fileSentinel), {
      authorization: basic(password),
      cookie: `sid=${cookieSentinel}`,
      host: hostSentinel,
      origin: originSentinel,
      referer: refererSentinel,
    });
    expect(response.statusCode).toBe(201);

    const text = output();
    // The library line is still emitted; only its header values are gone.
    expect(text).toContain("Providing options to busboy");
    expect(text).toContain("[Redacted]");
    // The request remains observable: method, matched route, status and elapsed time.
    expect(text).toContain('"msg":"incoming request"');
    expect(text).toContain('"method":"POST"');
    expect(text).toContain('"route":"/api/books"');
    expect(text).toContain('"msg":"request completed"');
    expect(text).toContain('"statusCode":201');
    expect(text).toContain('"responseTime"');

    for (const sentinel of [password, passwordEncoded, hostSentinel, cookieSentinel, originSentinel, refererSentinel, fileSentinel]) {
      expect(text, `leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("censors lowercase, capitalized and dynamic header names anywhere in a log object", async () => {
    const { app, output } = await appAt("trace");
    const sentinels = {
      authorization: "AUTHORIZATION-SENTINEL",
      proxyAuthorization: "PROXY-AUTHORIZATION-SENTINEL",
      cookie: "COOKIE-SENTINEL",
      setCookie: "SET-COOKIE-SENTINEL",
      xAuthKey: "X-AUTH-KEY-SENTINEL",
      xAuthUser: "X-AUTH-USER-SENTINEL",
      xApiKey: "X-API-KEY-SENTINEL",
      xGoogApiKey: "X-GOOG-API-KEY-SENTINEL",
      host: "HOST-SENTINEL",
      origin: "ORIGIN-SENTINEL",
      referer: "REFERER-SENTINEL",
      bodyKey: "BODY-KEY-SENTINEL",
      password: "PASSWORD-SENTINEL",
    };

    app.log.trace(
      {
        busboyOptions: {
          headers: {
            authorization: `Basic ${sentinels.authorization}`,
            "proxy-authorization": sentinels.proxyAuthorization,
            cookie: `sid=${sentinels.cookie}`,
            "set-cookie": `sid=${sentinels.setCookie}`,
            "x-auth-key": sentinels.xAuthKey,
            "x-auth-user": sentinels.xAuthUser,
            "x-api-key": sentinels.xApiKey,
            "x-goog-api-key": sentinels.xGoogApiKey,
            host: sentinels.host,
            origin: sentinels.origin,
            referer: sentinels.referer,
            "x-session-id": "SESSION-VALUE-KEPT",
          },
        },
        res: { headers: { "Set-Cookie": `sid=${sentinels.setCookie}` } },
      },
      "lowercase headers",
    );
    app.log.trace(
      {
        busboyOptions: {
          headers: {
            Authorization: `Basic ${sentinels.authorization}`,
            "Proxy-Authorization": sentinels.proxyAuthorization,
            Cookie: `sid=${sentinels.cookie}`,
            "Set-Cookie": `sid=${sentinels.setCookie}`,
            "X-Auth-Key": sentinels.xAuthKey,
            "X-Auth-User": sentinels.xAuthUser,
            "X-Api-Key": sentinels.xApiKey,
            "X-Goog-Api-Key": sentinels.xGoogApiKey,
            Host: sentinels.host,
            Origin: sentinels.origin,
            Referer: sentinels.referer,
          },
        },
        request: { headers: { Authorization: `Bearer ${sentinels.authorization}` } },
      },
      "capitalized headers",
    );
    app.log.trace(
      {
        req: {
          method: "POST",
          url: "/api/books?token=QUERY-SENTINEL",
          headers: { authorization: `Basic ${sentinels.authorization}` },
          body: { password: sentinels.password, apiKey: sentinels.bodyKey },
        },
      },
      "request-shaped object",
    );
    app.log.trace({ credentials: { password: sentinels.password, apiKey: sentinels.bodyKey } }, "credentials");

    const text = output();
    expect(text).toContain("lowercase headers");
    expect(text).toContain("capitalized headers");
    expect(text).toContain("request-shaped object");
    expect(text).toContain("[Redacted]");
    expect(text).toContain('"x-session-id":"SESSION-VALUE-KEPT"');
    for (const sentinel of Object.values(sentinels)) {
      expect(text, `leaked ${sentinel}`).not.toContain(sentinel);
    }
    expect(text).not.toContain("QUERY-SENTINEL");
  });

  it("never logs Basic, KOSync, Cookie or MCP credentials at trace", async () => {
    const previous = { mcp: { ...config.mcp }, logLevel: config.logLevel };
    config.mcp.enabled = true;
    config.mcp.ratePerMin = 1_000;
    config.mcp.writeRatePerMin = 1_000;
    try {
      const { app, output } = await appAt("trace");
      const wrongPassword = "WRONG-PASSWORD-SENTINEL";
      const wrongBasic = Buffer.from(`${config.user}:${wrongPassword}`).toString("base64");
      const rightBasic = Buffer.from(`${config.user}:${config.password}`).toString("base64");
      const kosyncUser = "KOSYNC-USER-SENTINEL";
      const kosyncKey = "KOSYNC-KEY-SENTINEL";
      const cookie = "COOKIE-SENTINEL-VALUE";
      const referer = "http://REFERER-SENTINEL.test/page";

      const rejected = await app.inject({
        method: "GET",
        url: "/api/books",
        headers: { authorization: `Basic ${wrongBasic}` },
      });
      expect(rejected.statusCode).toBe(401);
      const accepted = await app.inject({ method: "GET", url: "/api/books", headers: { authorization: basic(config.password) } });
      expect(accepted.statusCode).toBe(200);
      const kosync = await app.inject({
        method: "GET",
        url: "/kosync/users/auth",
        headers: { "x-auth-user": kosyncUser, "x-auth-key": kosyncKey, cookie },
      });
      expect(kosync.statusCode).toBe(401);

      const created = await app.inject({
        method: "POST",
        url: "/api/mcp/tokens",
        headers: { authorization: basic(config.password) },
        payload: { name: "log-sweep", scope: "read" },
      });
      expect(created.statusCode).toBe(201);
      const token = (created.json() as { token: string }).token;
      const rpc = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          cookie,
          referer,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect([200, 202]).toContain(rpc.statusCode);

      const text = output();
      expect(text).toContain("auth failed provider=basic");
      expect(text).toContain("mcp_call");
      expect(text).toContain('"msg":"request completed"');
      expect(text).toContain('"statusCode":200');
      expect(text).toContain('"responseTime"');

      const forbidden = [
        wrongPassword,
        wrongBasic,
        rightBasic,
        config.password,
        kosyncUser,
        kosyncKey,
        cookie,
        referer,
        token,
      ];
      for (const sentinel of forbidden) {
        expect(text, `leaked ${sentinel}`).not.toContain(sentinel);
      }
      expect(text).not.toContain("knw_mcp_");
      expect(text).not.toMatch(/Authorization:\s/iu);
    } finally {
      Object.assign(config.mcp, previous.mcp);
      config.logLevel = previous.logLevel;
    }
  });

  it("keeps upload headers out of every level, including silent", async () => {
    const password = config.password;
    const passwordEncoded = Buffer.from(`${config.user}:${password}`).toString("base64");
    const fileSentinel = "FILE-CONTENT-LEVEL-SENTINEL";
    for (const level of LOG_LEVELS) {
      const { app, output } = await appAt(level);
      const response = await upload(app, epub(`Level ${level}`), {
        authorization: basic(password),
        cookie: "COOKIE-LEVEL-SENTINEL",
        host: "HOST-LEVEL-SENTINEL",
      });
      expect(response.statusCode).toBe(201);
      const text = output();
      for (const sentinel of [password, passwordEncoded, "COOKIE-LEVEL-SENTINEL", "HOST-LEVEL-SENTINEL", fileSentinel]) {
        expect(text, `${level} leaked ${sentinel}`).not.toContain(sentinel);
      }
      if (level === "silent" || level === "error" || level === "warn") {
        expect(text).toBe("");
      } else {
        expect(text).toContain('"msg":"request completed"');
      }
    }
  });
});
