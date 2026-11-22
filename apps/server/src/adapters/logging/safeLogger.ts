import { isIP } from "node:net";
import { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { safeErrorForLog } from "./safeError.js";

/**
 * Pino paths redacted at every level, including debug and trace. The serializers below
 * are the primary defence; these paths protect manual logger calls and third-party code
 * that passes a request or an error under a different key.
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
