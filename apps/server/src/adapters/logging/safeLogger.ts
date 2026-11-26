import { isIP } from "node:net";
import { types } from "node:util";
import { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger as PinoLogger, LogFn } from "pino";
import { safeErrorForLog } from "./safeError.js";

/**
 * Pino paths redacted at every level, including debug and trace. The serializers and the
 * `logMethod` hook below are the primary defence; these paths protect manual logger calls
 * and third-party code that passes a request or an error under a different key.
 */
export const REDACT_PATHS = [
  "req.url",
  "req.hostname",
  "req.headers",
  "req.query",
  "req.params",
  "req.body",
  'res.headers["set-cookie"]',
  "err.message",
  "err.stack",
  "err.cause",
  "error.message",
  "error.stack",
  "error.cause",
  "exception.message",
  "exception.stack",
  "exception.cause",
  "cause",
];

const CENSORED = "[Redacted]";
/**
 * Header names are attacker-controlled, so the censor matches by name instead of listing
 * paths. It covers the documented set (authorization, proxy-authorization, cookie,
 * set-cookie, x-auth-key, x-auth-user, x-api-key, x-goog-api-key) and any future header
 * that mentions a credential. `host`, `origin` and `referer` are added by the network
 * guard rule: no log level may record the request target or the peer's origin.
 */
const SENSITIVE_KEY = /(auth|token|secret|key|cookie|password)/i;
const SENSITIVE_KEY_EXACT: ReadonlySet<string> = new Set(["host", "origin", "referer"]);
/**
 * Guards against pathological or cyclic objects reaching the logger. A real log object is
 * small; anything past these limits is censored instead of walked. The node budget bounds
 * the total work across the whole argument list, not just one level.
 */
const MAX_LOG_DEPTH = 8;
const MAX_LOG_ENTRIES = 1_000;
const MAX_LOG_NODES = 10_000;
/**
 * Top-level keys whose values Pino runs through one of our serializers. The composition root
 * registers `safeRequestForLog` for `req` and `safeErrorForLog` for `err` only; a top-level
 * `res` has no serializer the censor can rely on, so it is always copied and censored. With
 * a bare Pino logger, keeping its identity would stringify the raw object and leak headers.
 */
const SERIALIZED_KEYS: ReadonlySet<string> = new Set(["req", "err"]);

type CensorState = {
  readonly seen: WeakMap<object, unknown>;
  remaining: number;
};

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY.test(key) || SENSITIVE_KEY_EXACT.has(key.toLowerCase());

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isError = (value: unknown): boolean => {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
};

/**
 * A proxy can answer `getOwnPropertyDescriptor` and `get` differently, so a descriptor
 * check cannot prove its serialization is safe. Never preserve a proxy's identity.
 */
const isProxy = (value: object): boolean => {
  try {
    return types.isProxy(value);
  } catch {
    return true;
  }
};

/**
 * Walks the prototype chain through property descriptors instead of reading `toJSON`, so a
 * getter is never invoked and cannot return a different value during serialization.
 */
const findToJSON = (
  value: object,
): { found: true; descriptor: PropertyDescriptor } | { found: false } => {
  try {
    let current: object | null = value;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
      if (descriptor !== undefined) return { found: true, descriptor };
      current = Object.getPrototypeOf(current);
    }
    return { found: false };
  } catch {
    // An unreadable prototype chain is not trustworthy; let the caller censor the value.
    return { found: true, descriptor: { get: () => undefined } };
  }
};

/**
 * `JSON.stringify` calls a callable `toJSON` on any object, even a non-enumerable or
 * inherited one, and its return value replaces the object. That makes `toJSON` an
 * attacker-controlled serialization channel: keep an object's identity only when its
 * `toJSON` is the built-in data property we know how to reason about.
 */
const keepsBuiltInToJSON = (value: object, builtIn: () => unknown): boolean => {
  const result = findToJSON(value);
  return result.found && "value" in result.descriptor && result.descriptor.value === builtIn;
};

const censorArray = (value: unknown[], state: CensorState, depth: number): unknown => {
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LOG_ENTRIES) return CENSORED;
  const copy: unknown[] = new Array(length);
  state.seen.set(value, copy);
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      copy[index] = CENSORED;
      continue;
    }
    if (descriptor === undefined) continue;
    // Never invoke an accessor: a getter can throw or synthesize a sensitive value.
    if (!("value" in descriptor)) {
      copy[index] = CENSORED;
      continue;
    }
    // A function element serializes as null and could only be dangerous as `toJSON`.
    if (typeof descriptor.value === "function") continue;
    copy[index] = censorLogValue(descriptor.value, state, depth + 1, false);
  }
  return copy;
};

/**
 * Whether a top-level `req`/`err` value must keep its identity so Pino's serializer still
 * sees the original request or error. Plain objects and arrays are still walked (their
 * serializers work on the censored copy), and proxies are never preserved. `res` is not in
 * that set: the censor cannot rely on a host-provided serializer, so every reply value is
 * copied and censored.
 */
const preservesSerializerIdentity = (key: string, value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value) || isPlainObject(value) || isProxy(value)) return false;
  return key === "req" || key === "err";
};

const censorRecord = (value: object, state: CensorState, depth: number, root: boolean): unknown => {
  const keys = Object.keys(value);
  if (keys.length > MAX_LOG_ENTRIES) return CENSORED;
  // A null prototype keeps an attacker-supplied `__proto__` key a plain data key and keeps
  // the copy free of an inherited `toJSON`, which `JSON.stringify` would call.
  const copy: Record<string, unknown> = Object.create(null);
  state.seen.set(value, copy);
  for (const key of keys) {
    if (isSensitiveKey(key)) {
      copy[key] = CENSORED;
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      copy[key] = CENSORED;
      continue;
    }
    if (descriptor === undefined) continue;
    // Never invoke an accessor: a getter can throw or synthesize a sensitive value.
    if (!("value" in descriptor)) {
      copy[key] = CENSORED;
      continue;
    }
    const entry = descriptor.value;
    // Functions are omitted by serialization. Dropping them also drops a `toJSON` that
    // would otherwise replace the whole object with attacker-controlled content.
    if (typeof entry === "function") continue;
    if (root && SERIALIZED_KEYS.has(key) && preservesSerializerIdentity(key, entry)) {
      copy[key] = entry;
      continue;
    }
    copy[key] = censorLogValue(entry, state, depth + 1, false);
  }
  return copy;
};

const censorObject = (value: object, state: CensorState, depth: number, root: boolean): unknown => {
  if (Array.isArray(value)) return censorArray(value, state, depth);
  // A proxy of a Date or a Buffer can pass `instanceof`, so only trust real instances.
  const proxy = isProxy(value);
  if (!proxy && value instanceof Date) {
    return keepsBuiltInToJSON(value, Date.prototype.toJSON) ? value : CENSORED;
  }
  if (!proxy && Buffer.isBuffer(value)) {
    return keepsBuiltInToJSON(value, Buffer.prototype.toJSON) ? value : CENSORED;
  }
  // Nested errors are reduced to the allowlisted type; a top-level error and the `err` key
  // keep their identity so Pino's `err` serializer still runs (see `safeLogMethod`).
  if (value instanceof Error) return safeErrorForLog(value);
  return censorRecord(value, state, depth, root);
};

/**
 * Returns a censored copy of a log value. Every object is cloned through its property
 * descriptors so accessors are never invoked, functions (including `toJSON`) never reach
 * the serializer, and class instances cannot replace their content during serialization.
 * Only dates, buffers and error identities that Pino's serializers handle are preserved.
 */
const censorLogValue = (
  value: unknown,
  state: CensorState,
  depth: number,
  root: boolean,
): unknown => {
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_LOG_DEPTH || state.remaining <= 0) return CENSORED;
  state.remaining -= 1;
  const known = state.seen.get(value);
  if (known !== undefined) return known;
  try {
    return censorObject(value, state, depth, root);
  } catch {
    // Proxies and other exotic objects can throw from any trap; censor just this value.
    return CENSORED;
  }
};

/**
 * Pino `hooks.logMethod`: the single place that censors object arguments before any level,
 * including trace, reaches the stream. A path-based `redact` cannot see dynamic keys such
 * as the `busboyOptions.headers` object that `@fastify/multipart` logs, so the whole
 * argument is walked by key name instead. It never throws: a logger that fails would break
 * the request it is only supposed to describe.
 */
export const safeLogMethod = function (
  this: PinoLogger,
  args: Parameters<LogFn>,
  method: LogFn,
): void {
  try {
    const state: CensorState = { seen: new WeakMap<object, unknown>(), remaining: MAX_LOG_NODES };
    for (let index = 0; index < args.length; index += 1) {
      // `pino`'s write() moves a top-level Error under the `err` key, where the configured
      // serializer replaces the whole value; keep that identity so the serializer applies.
      if (index === 0 && isError(args[index])) continue;
      args[index] = censorLogValue(args[index], state, 0, index === 0);
    }
  } catch {
    // Last-resort containment: drop every object argument rather than risk a raw header.
    for (let index = 0; index < args.length; index += 1) {
      if (typeof args[index] === "object" && args[index] !== null) args[index] = CENSORED;
    }
  }
  method.apply(this, args);
};

const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const ROUTE_PATTERN = /^\/[A-Za-z0-9_./:*{}-]{1,200}$/;

const read = (value: unknown, key: string): unknown => {
  try {
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
};

/** HTTP methods are a closed set; anything else is reported generically. */
export const safeMethod = (value: unknown): string => {
  if (typeof value !== "string") return "OTHER";
  const method = value.toUpperCase();
  return ALLOWED_METHODS.has(method) ? method : "OTHER";
};

const routeOf = (request: unknown): string | undefined => {
  const url = read(read(request, "routeOptions"), "url");
  return typeof url === "string" && ROUTE_PATTERN.test(url) ? url : undefined;
};

const addressOf = (request: unknown): string | undefined => {
  const ip = read(request, "ip");
  return typeof ip === "string" && isIP(ip) !== 0 ? ip : undefined;
};

/**
 * Fastify's default request line logs `req.url`, which carries the full pathname and the
 * query string. The safe line keeps only the method, the matched route pattern (server
 * declared) and the client address; unknown paths and hostnames never reach the log.
 */
export const safeRequestForLog = (value: unknown): Record<string, unknown> => {
  const route = routeOf(value);
  const remoteAddress = addressOf(value);
  return {
    method: safeMethod(read(value, "method")),
    ...(route === undefined ? {} : { route }),
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  };
};

/**
 * Replaces Fastify's internal logger lines so 404s and framework errors never use the raw
 * URL or the exception message. Application code, `req.log` and the root logger still use
 * the same Pino serializers, so third-party errors are reduced by `safeErrorForLog`.
 */
export class SafeLogController extends LogController {
  override incomingRequest(request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    request.log.info({ req: request }, "incoming request");
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) return;
    if (error) {
      reply.log.error(
        { statusCode: reply.statusCode, err: error, responseTime: reply.elapsedTime },
        "request errored",
      );
    } else {
      reply.log.info(
        { statusCode: reply.statusCode, responseTime: reply.elapsedTime },
        "request completed",
      );
    }
  }

  override defaultErrorLog(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    if (reply.statusCode >= 500) {
      reply.log.error({ statusCode: reply.statusCode, err: error }, "request failed");
    } else {
      reply.log.info({ statusCode: reply.statusCode, err: error }, "request failed");
    }
  }

  override streamError(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    if (read(error, "code") === "ERR_STREAM_PREMATURE_CLOSE") {
      reply.log.info({ statusCode: reply.statusCode }, "stream closed prematurely");
    } else {
      reply.log.warn({ err: error }, "response terminated with an error after headers were sent");
    }
  }

  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info({ method: safeMethod(request.method) }, "route not found");
  }

  override writeHeadError(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    reply.log.warn({ err: error }, "failed to write response headers");
  }

  override serializerError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
    metadata: { statusCode: number },
  ): void {
    if (this.isLogDisabled(request)) return;
    reply.log.error({ err: error, statusCode: metadata.statusCode }, "response serializer failed");
  }
}

export { safeErrorForLog };
