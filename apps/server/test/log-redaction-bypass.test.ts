import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import pino, { type Logger as PinoLogger } from "pino";
import { safeLogMethod } from "../src/adapters/logging/safeLogger.js";
import { openDb } from "../src/adapters/storage/db.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>["app"]> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  config.logLevel = previousLevel;
});

const previousLevel = config.logLevel;

async function appAtTrace(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>["app"];
  output: () => string;
}> {
  const root = await mkdtemp(join(tmpdir(), "knowlify-log-bypass-"));
  roots.push(root);
  config.dataDir = root;
  config.booksDir = join(root, "books");
  config.coversDir = join(root, "covers");
  config.logLevel = "trace";
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

/**
 * A Pino logger with the hook and nothing else: no serializers and no path redaction. This
 * is the exact configuration the reviewer used to reproduce the `res` bypass, so the test
 * proves the hook alone protects every value handed to it.
 */
function hookOnlyLogger(): { log: PinoLogger; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const log = pino({ hooks: { logMethod: safeLogMethod } }, stream);
  return { log, output: () => chunks.join("") };
}

describe("log censor serialization bypass", () => {
  it("drops a nested toJSON instead of letting it replace the censored object", async () => {
    const { app, output } = await appAtTrace();
    const secret = "JSON-TOJSON-SECRET";

    // The reported bypass: the clone kept `toJSON`, and JSON.stringify called it, so the
    // returned Authorization value never passed through the key censor.
    expect(() => app.log.info(
      { nested: { toJSON: () => ({ Authorization: secret }) } },
      "tojson-bypass-probe",
    )).not.toThrow();

    const text = output();
    expect(text).toContain("tojson-bypass-probe");
    expect(text).not.toContain(secret);
    expect(text).not.toContain('"Authorization"');
  });

  it("censors toJSON, getters, exotic instances, arrays and cycles without throwing", async () => {
    const { app, output } = await appAtTrace();
    const secret = "SERIALIZATION-SECRET";
    let getterInvoked = false;

    const exotic = new (class {
      toJSON(): Record<string, string> {
        return { Authorization: secret };
      }
    })();
    const evilDate = new (class extends Date {
      override toJSON(): Record<string, string> {
        return { Authorization: secret };
      }
    })();
    const cyclic: Record<string, unknown> = { label: "cycle" };
    cyclic.self = cyclic;
    cyclic.toJSON = () => ({ Authorization: secret });
    const hostileProxy = new Proxy({}, {
      getPrototypeOf() {
        throw new Error(secret);
      },
      ownKeys() {
        throw new Error(secret);
      },
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    });
    // A proxy of a Date/Buffer passes `instanceof` but can answer `get` differently from
    // `getOwnPropertyDescriptor`; identity must not be preserved for it.
    const proxiedDate = new Proxy(new Date(), {
      get(target, property, receiver) {
        if (property === "toJSON") return () => ({ Authorization: secret });
        return Reflect.get(target, property, receiver);
      },
    });
    const proxiedBuffer = new Proxy(Buffer.from("payload"), {
      get(target, property, receiver) {
        if (property === "toJSON") return () => ({ Authorization: secret });
        return Reflect.get(target, property, receiver);
      },
    });
    const withGetter = {
      get Authorization() {
        getterInvoked = true;
        return secret;
      },
      get throwing(): never {
        throw new Error(secret);
      },
    };

    expect(() => app.log.info(
      {
        deep: [{ payload: { toJSON: () => ({ authorization: secret }) } }, exotic, evilDate],
        list: [
          { toJSON: () => ({ authorization: secret }) },
          { get token() { return secret; } },
        ],
        cyclic,
        hostileProxy,
        proxiedDate,
        proxiedBuffer,
        withGetter,
      },
      "hostile-values-probe",
    )).not.toThrow();

    const text = output();
    expect(text).toContain("hostile-values-probe");
    expect(text).toContain("[Redacted]");
    expect(text).not.toContain(secret);
    // Accessors are censored through their descriptors, never invoked.
    expect(getterInvoked).toBe(false);
  });

  it("censors a reply instance logged under res when no serializer is registered", () => {
    const { log, output } = hookOnlyLogger();
    const secret = "RES-HEADER-SECRET";

    // The reported bypass: `res` kept the class instance's identity even though no `res`
    // serializer exists, so Pino stringified its raw headers. Only req/err keep identity.
    class Reply {
      headers: Record<string, string>;
      statusCode: number;

      constructor() {
        this.headers = { authorization: secret, "set-cookie": `sid=${secret}` };
        this.statusCode = 200;
      }
    }

    expect(() => log.info({ res: new Reply() }, "reply-probe")).not.toThrow();

    const text = output();
    expect(text).toContain(
      '"res":{"headers":{"authorization":"[Redacted]","set-cookie":"[Redacted]"},"statusCode":200}',
    );
    expect(text).not.toContain(secret);
  });

  it("censors class, proxy and accessor reply values under res without invoking them", () => {
    const { log, output } = hookOnlyLogger();
    const secret = "RES-EXOTIC-SECRET";
    let getterInvoked = false;

    class ReplyWithToJSON {
      statusCode = 200;

      toJSON(): Record<string, unknown> {
        return { authorization: secret, statusCode: 200 };
      }
    }
    const withAccessor = Object.defineProperty({ statusCode: 200 }, "headers", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return { authorization: secret };
      },
    });
    const hostileProxy = new Proxy({ statusCode: 200 }, {
      getPrototypeOf() {
        throw new Error(secret);
      },
      ownKeys() {
        throw new Error(secret);
      },
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    });

    expect(() => log.info({ res: new ReplyWithToJSON() }, "res-tojson-probe")).not.toThrow();
    expect(() => log.info({ res: withAccessor }, "res-accessor-probe")).not.toThrow();
    expect(() => log.info({ res: hostileProxy }, "res-proxy-probe")).not.toThrow();

    const text = output();
    // `toJSON` is dropped by the descriptor copy, so it cannot replace the censored object.
    expect(text).toContain('"res":{"statusCode":200},"msg":"res-tojson-probe"');
    // The accessor is censored by name and never invoked.
    expect(text).toContain('"res":{"statusCode":200,"headers":"[Redacted]"},"msg":"res-accessor-probe"');
    // An unreadable proxy is censored as a whole.
    expect(text).toContain('"res":"[Redacted]","msg":"res-proxy-probe"');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('"authorization"');
    expect(getterInvoked).toBe(false);
  });

  it("keeps the res statusCode when a reply value reaches the app logger", async () => {
    const { app, output } = await appAtTrace();
    const secret = "RES-APP-SECRET";

    class Reply {
      headers = { authorization: secret };
      statusCode = 200;
    }

    expect(() => app.log.info({ res: new Reply() }, "app-reply-probe")).not.toThrow();

    // Fastify adds its own `res` serializer (statusCode only), so the whole-app path keeps
    // the field while the censored copy guarantees no header can reach the stream.
    const text = output();
    expect(text).toContain('"res":{"statusCode":200},"msg":"app-reply-probe"');
    expect(text).not.toContain(secret);
  });

  it("keeps the req and err serializers working after the censor walks objects", async () => {
    const { app, output } = await appAtTrace();
    const secret = "ERROR-CONTENT-SECRET";

    await app.inject({ method: "GET", url: "/health" });
    const error = new Error(`provider failed with ${secret}`);
    error.name = "HostileProviderError";
    expect(() => app.log.error(error, "failure-probe")).not.toThrow();

    const text = output();
    expect(text).toContain('"msg":"incoming request"');
    expect(text).toContain('"method":"GET"');
    expect(text).toContain('"route":"/health"');
    expect(text).toContain('"msg":"failure-probe"');
    expect(text).toContain('"err":{"type":"Error","message":"[Redacted]","stack":"[Redacted]"}');
    expect(text).not.toContain(secret);
    expect(text).not.toContain("HostileProviderError");
  });
});
