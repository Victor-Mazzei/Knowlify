import type { ServerResponse } from "node:http";
import type { FastifyError, FastifyInstance } from "fastify";
import {
  ChatDisabledError,
  ChatRateLimitedError,
  ConversationFullError,
  ConversationScopeMismatchError,
  LibraryChatUnavailableError,
} from "../../domain/assistant/errors.js";
import { NotFoundError, ValidationError } from "../../domain/errors.js";
import {
  MAX_CONVERSATION_ID_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_QUESTION_CHARS,
  MAX_SECTION_CHARS,
} from "../../domain/assistant/Conversation.js";
import type { Chat, ChatEvent, ChatTurnInput } from "../../use-cases/Chat.js";

const BODY_LIMIT = 32 * 1024;
/**
 * SSE comment cadence. Besides keeping proxies from idling the stream, a byte every
 * second works around the WebKit releases affected by bugs.webkit.org 322545, which
 * can strand an already-received chunk until the server writes again. Two concurrent
 * streams cost only a few bytes per second.
 */
export const HEARTBEAT_MS = 1_000;

export interface ChatRoutesOptions {
  chat: Chat;
  /** Test seam; production uses HEARTBEAT_MS. */
  heartbeatMs?: number;
}

/*
 * Fastify's default Ajv removes unknown properties instead of rejecting them, and with
 * `oneOf` that mutation erases fields the second branch needs. `propertyNames` keeps the
 * documented "no extra properties" behaviour without mutating the body.
 */
const scopeSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind"],
      propertyNames: { enum: ["kind"] },
      properties: { kind: { type: "string", enum: ["library"] } },
    },
    {
      type: "object",
      required: ["kind", "bookId"],
      propertyNames: { enum: ["kind", "bookId", "excerpt", "excerptKind", "page", "section"] },
      properties: {
        kind: { type: "string", enum: ["book"] },
        bookId: { type: "string", minLength: 1 },
        excerpt: { type: "string", minLength: 1, maxLength: MAX_EXCERPT_CHARS },
        excerptKind: { type: "string", enum: ["selection", "visible"] },
        page: { type: "integer", minimum: 0 },
        section: { type: "string", maxLength: MAX_SECTION_CHARS },
      },
    },
  ],
} as const;

const messageBodySchema = {
  type: "object",
  required: ["message", "scope"],
  propertyNames: { enum: ["conversationId", "message", "scope"] },
  properties: {
    conversationId: { type: "string", minLength: 1, maxLength: MAX_CONVERSATION_ID_CHARS },
    message: { type: "string", minLength: 1, maxLength: MAX_QUESTION_CHARS },
    scope: scopeSchema,
  },
} as const;

const listQuerySchema = {
  type: "object",
  propertyNames: { enum: ["bookId", "limit"] },
  properties: {
    bookId: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  },
} as const;

interface ListQuery {
  bookId?: string;
  limit?: number;
}

/**
 * HTTP boundary for the Assistant context. `POST /chat/messages` uses SSE: the first
 * event is produced before hijacking so validation/rate-limit failures can still be
 * regular JSON errors. CORS headers are copied because hijacked replies skip hooks.
 */
export async function chatRoutes(app: FastifyInstance, opts: ChatRoutesOptions) {
  const { chat, heartbeatMs = HEARTBEAT_MS } = opts;

  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error.validation) return reply.code(400).send({ message: error.message });
    if (error instanceof ValidationError) return reply.code(400).send({ message: error.message });
    if (error instanceof NotFoundError) return reply.code(404).send({ message: error.message });
    if (error instanceof ConversationScopeMismatchError) {
      return reply.code(409).send({ message: error.message });
    }
    if (error instanceof ConversationFullError) {
      return reply.code(409).send({ message: error.message, code: error.code });
    }
    if (error instanceof LibraryChatUnavailableError) {
      return reply.code(409).send({ message: error.message });
    }
    if (error instanceof ChatDisabledError) {
      return reply.code(503).send({ message: error.message, code: error.code });
    }
    if (error instanceof ChatRateLimitedError) {
      return reply
        .header("Retry-After", String(error.retryAfterSec))
        .code(429)
        .send({ message: error.message, code: error.code });
    }
    if (error.statusCode === 413) return reply.code(413).send({ message: "Request body is too large" });
    return reply.send(error);
  });

  app.get("/chat/status", async () => chat.status());

  app.post<{ Body: ChatTurnInput }>(
    "/chat/messages",
    { schema: { body: messageBodySchema }, bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const controller = new AbortController();
      const response = reply.raw;
      let closed = false;
      let hijacked = false;

      // Register before the first await: a disconnect during retrieval must abort the
      // use case before it can reach the provider.
      const onClose = () => {
        if (!response.writableEnded) {
          closed = true;
          controller.abort();
        }
      };
      response.on("close", onClose);

      const clientGone = (): boolean =>
        closed ||
        controller.signal.aborted ||
        response.destroyed ||
        response.writableEnded ||
        response.socket?.destroyed === true ||
        request.raw.aborted ||
        request.raw.socket?.destroyed === true;

      const abortIfGone = (): boolean => {
        if (!clientGone()) return false;
        closed = true;
        if (!controller.signal.aborted) controller.abort();
        return true;
      };

      const abandonReply = (): void => {
        if (!hijacked) {
          reply.hijack();
          hijacked = true;
        }
      };

      const iterator = chat.stream(request.body, controller.signal)[Symbol.asyncIterator]();
      try {
        if (abortIfGone()) {
          abandonReply();
          return;
        }

        const first = await iterator.next();
        if (first.done) {
          if (abortIfGone()) {
            abandonReply();
            return;
          }
          return reply.code(204).send();
        }
        if (abortIfGone()) {
          abandonReply();
          return;
        }

        // Fastify hooks do not run after hijack; snapshot the CORS headers it already set.
        const headers: Record<string, string | number | string[]> = {};
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) headers[name] = value;
        }
        reply.hijack();
        hijacked = true;
        response.writeHead(200, {
          ...headers,
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          // A reverse proxy that compresses this stream (Traefik's compress middleware
          // does unless told otherwise) buffers it and can trigger WebKit's compressed
          // chunked-response hang. An explicit identity coding makes the proxy skip it.
          "content-encoding": "identity",
        });
        response.flushHeaders?.();

        const heartbeat = setInterval(() => {
          if (!closed && !response.writableEnded) response.write(": ping\n\n");
        }, heartbeatMs);
        heartbeat.unref();

        try {
          writeEvent(response, first.value);
          if (first.value.type !== "done" && first.value.type !== "error") {
            for (;;) {
              if (abortIfGone()) break;
              const next = await iterator.next();
              if (next.done || abortIfGone()) break;
              if (!writeEvent(response, next.value)) break;
              if (next.value.type === "done" || next.value.type === "error") break;
            }
          }
        } catch {
          // The terminal event may already be gone; never leak provider details mid-stream.
          if (!abortIfGone()) {
            writeEvent(response, {
              type: "error",
              code: "llm_protocol",
              message: "The language model returned an unexpected response",
            });
          }
        } finally {
          clearInterval(heartbeat);
        }
      } catch (error) {
        // A disconnected client cannot receive a JSON error; do not hand a dead reply
        // back to Fastify.
        if (abortIfGone()) {
          abandonReply();
          return;
        }
        throw error;
      } finally {
        response.off("close", onClose);
        await iterator.return?.(undefined);
        if (hijacked && !response.writableEnded && !response.destroyed) response.end();
      }
    },
  );

  app.get<{ Querystring: ListQuery }>(
    "/chat/conversations",
    { schema: { querystring: listQuerySchema } },
    async (request) => chat.list({ bookId: request.query.bookId, limit: request.query.limit }).map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      scope: conversation.scope,
      updatedAt: conversation.updatedAt,
    })),
  );

  app.get<{ Params: { id: string } }>("/chat/conversations/:id", async (request, reply) => {
    const detail = chat.get(request.params.id);
    if (!detail) return reply.code(404).send({ message: "Not found" });
    return {
      id: detail.conversation.id,
      title: detail.conversation.title,
      scope: detail.conversation.scope,
      messages: detail.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        citations: message.citations,
        createdAt: message.createdAt,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>("/chat/conversations/:id", async (request, reply) => {
    if (!chat.remove(request.params.id)) return reply.code(404).send({ message: "Not found" });
    return reply.code(204).send();
  });
}

function writeEvent(response: ServerResponse, event: ChatEvent): boolean {
  if (response.writableEnded || response.destroyed) return false;
  response.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}
