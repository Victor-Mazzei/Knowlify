import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/adapters/storage/db.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { ReleaseFetchResult } from "../src/ports/update.js";
import { UpdateNotice } from "../src/use-cases/UpdateNotice.js";

const SENTINEL = "SENTINEL-UPDATE-4c1e9d";
const original = { update: { ...config.update }, logLevel: config.logLevel };

afterEach(() => {
  config.update = { ...original.update };
  config.logLevel = original.logLevel;
});

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const fakeFetch = (payload: unknown, headers: Record<string, string> = {}) =>
  (async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  })) as typeof globalThis.fetch;

const collected = () => {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(String(chunk));
      callback();
    },
  });
  return { logs, stream };
};

describe("update notice log sentinel", () => {
  it("never logs a tag, ETag or provider text at trace level", async () => {
    config.update = { enabled: true, locked: false };
    config.logLevel = "trace";
    const { logs, stream } = collected();
    const db = openDb(":memory:");
    const { app } = await buildApp(db, { stream }, undefined, undefined, {
      update: {
        currentVersion: "2.4.0",
        fetch: fakeFetch(
          {
            tag_name: `v2.5.0-${SENTINEL}`,
            name: SENTINEL,
            body: SENTINEL,
            html_url: `https://example.invalid/${SENTINEL}`,
          },
          { etag: `W/"${SENTINEL}"`, "x-sentinel": SENTINEL },
        ),
      },
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/update/check",
        headers: auth,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(SENTINEL);
      await new Promise((resolve) => setImmediate(resolve));
      expect(logs.join("")).not.toContain(SENTINEL);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("never logs a valid release's provider body or a stored ETag", async () => {
    const messages: string[] = [];
    let now = Date.parse("2026-11-25T12:00:00.000Z");
    let result: ReleaseFetchResult = {
      outcome: "ok",
      release: {
        tag: "v2.5.0",
        version: { major: "2", minor: "5", patch: "0", prerelease: [] },
      },
      etag: `W/"${SENTINEL}"`,
    };
    const notice = new UpdateNotice({
      currentVersion: "2.4.0",
      env: { enabled: true },
      locked: false,
      source: {
        latest: async () => result,
      },
      stateStore: {
        load: () => null,
        save: () => {},
        clear: () => {},
      },
      configStore: {
        load: () => null,
        save: () => {},
      },
      clock: { now: () => now },
      log: {
        info: (message) => messages.push(message),
        error: (_error, message) => messages.push(message),
        warn: (message) => messages.push(message),
        debug: (message) => messages.push(message),
      },
    });
    notice.bootstrap();
    await notice.checkNow(true);
    now += 61_000;
    result = { outcome: "not_modified", etag: `W/"${SENTINEL}"` };
    await notice.checkNow(true);
    expect(messages.join("")).not.toContain(SENTINEL);
  });
});
