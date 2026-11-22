import type { IncomingMessage } from "node:http";
import type { AuthInfo, McpHttpHandler } from "@modelcontextprotocol/server";
import { validateHostHeader } from "@modelcontextprotocol/server";
import { toNodeHandler, type FetchLikeMcpHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { safeAddress } from "../outboundDebug.js";
import type { config } from "../../config.js";
import type { Logger } from "../../ports/index.js";
import type { Library } from "../../use-cases/Library.js";
import type { McpAccess } from "../../use-cases/McpAccess.js";
import type { Notes } from "../../use-cases/Notes.js";
import type { PassageSearch } from "../../use-cases/PassageSearch.js";
import type { Progress } from "../../use-cases/Progress.js";
import type { Tags } from "../../use-cases/Tags.js";
import type { Favorites } from "../../use-cases/Favorites.js";
import type { Indexing } from "../../use-cases/Indexing.js";
import { authInfoFor, McpAuth } from "./McpAuth.js";
import { createMcpHandlers } from "./buildMcpServer.js";
import { RateWindow } from "./RateWindow.js";
import {
  MAX_JSONRPC_ID_BYTES,
  WRITE_TOOL_SET,
  withMcpCallRecord,
  type McpCallRecord,
  type McpToolDeps,
} from "./tools/shared.js";

export interface McpRouteOptions {
  mcpAccess: McpAccess;
  library: Library;
  search: PassageSearch;
  notes: Notes;
  tags: Tags;
  favorites: Favorites;
  indexing: Indexing;
  progress: Progress;
  version: string;
  settings: typeof config.mcp;
  log: Logger;
}

const callOf = (message: unknown): string | null => {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const record = message as { method?: unknown; params?: unknown };
  if (record.method !== "tools/call") return null;
  if (typeof record.params !== "object" || record.params === null || Array.isArray(record.params)) return null;
  const name = (record.params as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
};

const toolCalls = (body: unknown): Array<string | null> => {
  if (Array.isArray(body)) return body.flatMap((message) => {
    const name = callOf(message);
    return name === null ? [] : [name];
  });
  const name = callOf(body);
  return name === null ? [] : [name];
};

const messagesOf = (body: unknown): Array<Record<string, unknown>> => {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter((message): message is Record<string, unknown> =>
    typeof message === "object" && message !== null && !Array.isArray(message));
};

/** JSON-RPC batches are accepted up to this many messages (transport 2025-03-26). */
const MAX_BATCH_MESSAGES = 10;

/**
 * Rejects envelopes whose echo could not stay within `maxResponseBytes`: an oversized
 * id or a batch too large for the per-item degradation to stay bounded.
 */
const envelopeErrorOf = (body: unknown): string | null => {
  if (Array.isArray(body)) {
    if (body.length === 0) return "Invalid Request: an empty batch is not allowed";
    if (body.length > MAX_BATCH_MESSAGES) {
      return `Invalid Request: a batch must not exceed ${MAX_BATCH_MESSAGES} messages`;
    }
  }
  for (const message of messagesOf(body)) {
    if (message.id === undefined) continue;
    if (Buffer.byteLength(JSON.stringify(message.id) ?? "", "utf8") > MAX_JSONRPC_ID_BYTES) {
      return "Invalid Request: the JSON-RPC id is too long";
    }
  }
  return null;
};

const invalidEnvelope = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message } });

/** Echoes the id only when it is small enough to keep a replacement error bounded. */
const responseIdOf = (body: unknown): string | number | null => {
  const [message] = messagesOf(body);
  const id = message?.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  return Buffer.byteLength(JSON.stringify(id) ?? "", "utf8") <= MAX_JSONRPC_ID_BYTES ? id : null;
};

/** Subscriptions are long-lived streams, not one bounded result. */
const isSubscription = (body: unknown): boolean =>
  messagesOf(body).some((message) => message.method === "subscriptions/listen");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idKeyOf = (value: unknown): string | null =>
  typeof value === "string" || typeof value === "number" ? JSON.stringify(value) : null;

const isStream = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

interface WireEntry {
  /** Serialized SSE event, or one serialized JSON-RPC message. */
  text: string;
  message: Record<string, unknown>;
}

/** One SSE event per response, as the legacy transport writes them. */
const sseEntries = (text: string): WireEntry[] | null => {
  const entries: WireEntry[] = [];
  for (const block of text.split("\n\n")) {
    if (block.length === 0) continue;
    const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
    if (dataLine === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    entries.push({ text: `${block}\n\n`, message: parsed });
  }
  return entries;
};

/** Plain JSON responses: a single message or an array of messages. */
const jsonEntries = (text: string): WireEntry[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (!messages.every(isRecord)) return null;
  return messages.map((message) => ({ text: JSON.stringify(message), message }));
};

const responseTooLargeEntry = (id: unknown, sse: boolean): WireEntry => {
  const message = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32603,
      message: "The response exceeds the MCP size limit",
      data: { code: "response_too_large" },
    },
  };
  return {
    text: sse ? `event: message\ndata: ${JSON.stringify(message)}\n\n` : JSON.stringify(message),
    message,
  };
};

/**
 * Normalizes a batch body: responses are put in request order and, when the whole body
 * would exceed `maxResponseBytes`, only the items that no longer fit become a small
 * `response_too_large` error. Returns null when the body is not one response per request
 * (the caller then keeps the original body or falls back to one bounded replacement).
 */
const normalizeBatch = (
  text: string,
  body: unknown[],
  maxResponseBytes: number,
  sse: boolean,
): string | null => {
  const entries = sse ? sseEntries(text) : jsonEntries(text);
  if (entries === null) return null;
  const requestKeys = body
    .map((message) => (isRecord(message) ? idKeyOf(message.id) : null))
    .filter((key): key is string => key !== null);
  const byKey = new Map<string, WireEntry>();
  for (const entry of entries) {
    const key = idKeyOf(entry.message.id);
    if (key === null || byKey.has(key)) return null;
    byKey.set(key, entry);
  }
  if (requestKeys.length !== entries.length || requestKeys.some((key) => !byKey.has(key))) return null;

  const serialize = (chosen: WireEntry[]): string => sse
    ? chosen.map((entry) => entry.text).join("")
    : JSON.stringify(chosen.map((entry) => entry.message));

  const chosen: WireEntry[] = [];
  for (let index = 0; index < requestKeys.length; index += 1) {
    const response = byKey.get(requestKeys[index]!)!;
    const later = requestKeys.slice(index + 1).map((key) => {
      const pending = byKey.get(key)!;
      return responseTooLargeEntry(pending.message.id, sse);
    });
    const attempt = serialize([...chosen, response, ...later]);
    chosen.push(Buffer.byteLength(attempt, "utf8") <= maxResponseBytes
      ? response
      : responseTooLargeEntry(response.message.id, sse));
  }
  const contained = serialize(chosen);
  return Buffer.byteLength(contained, "utf8") <= maxResponseBytes ? contained : null;
};

/** Keeps a one-element array response a batch, as JSON-RPC expects. */
const responseTooLarge = (body: unknown): Response => {
  const error = {
    jsonrpc: "2.0",
    id: responseIdOf(body),
    error: { code: -32603, message: "The response exceeds the MCP size limit" },
  };
  return Response.json(Array.isArray(body) ? [error] : error, { status: 500 });
};

/**
 * Last line of defense for responses built by the SDK (unknown tool names are echoed
 * back, for example): measure the serialized HTTP body, SSE framing included. A batch
 * keeps every response that fits and degrades the excess in place.
 */
const boundedResponses = (handler: McpHttpHandler, maxResponseBytes: number): FetchLikeMcpHandler => ({
  fetch: async (request, options) => {
    const response = await handler.fetch(request, options);
    const body = options?.parsedBody;
    if (request.method.toUpperCase() !== "POST" || response.body === null || isSubscription(body)) {
      return response;
    }
    const text = await response.text();
    const normalized = Array.isArray(body) && body.length > 0
      ? normalizeBatch(text, body, maxResponseBytes, isStream(response))
      : null;
    const payload = normalized ?? text;
    if (Buffer.byteLength(payload, "utf8") <= maxResponseBytes) {
      return new Response(payload, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return responseTooLarge(body);
  },
});

const tooMany = (reply: FastifyReply, retryAfterSec: number): FastifyReply =>
  reply.header("Retry-After", String(retryAfterSec)).code(429).send({ message: "Too many requests" });

/**
 * Fastify plugin for `/mcp` (ADR-3..7). The route bypasses Fastify's reply pipeline with
 * `hijack()` because the SDK writes the streamable HTTP response to the raw socket.
 */
export async function registerMcp(app: FastifyInstance, opts: McpRouteOptions): Promise<void> {
  const { settings } = opts;
  const toolDeps: McpToolDeps = {
    library: opts.library,
    search: opts.search,
    notes: opts.notes,
    tags: opts.tags,
    favorites: opts.favorites,
    indexing: opts.indexing,
    progress: opts.progress,
    maxResponseBytes: settings.maxResponseBytes,
    log: opts.log,
  };
  const handlers = createMcpHandlers(toolDeps, {
    version: opts.version,
    log: opts.log,
    maxRequestBodyBytes: settings.maxBodyBytes,
  });
  const auth = new McpAuth(opts.mcpAccess, { failurePerMin: settings.authFailurePerMin });
  const tokenRate = new RateWindow(settings.ratePerMin);
  const writeRate = new RateWindow(settings.writeRatePerMin);
  const nodeRead = toNodeHandler(boundedResponses(handlers.read, settings.maxResponseBytes), {
    maxRequestBodySize: settings.maxBodyBytes,
  });
  const nodeWrite = toNodeHandler(boundedResponses(handlers.write, settings.maxResponseBytes), {
    maxRequestBodySize: settings.maxBodyBytes,
  });

  app.addHook("onClose", async () => { await handlers.close(); });

  app.all(settings.path, { bodyLimit: settings.maxBodyBytes }, async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !settings.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ message: "Forbidden" });
    }
    if (settings.allowedHosts !== null) {
      const host = req.headers.host?.toLowerCase();
      if (host === undefined || !validateHostHeader(host, settings.allowedHosts).ok) {
        return reply.code(403).send({ message: "Forbidden" });
      }
    }

    const authenticated = auth.authenticate(req.headers.authorization, req.ip);
    if (!authenticated.ok) {
      // Category and client IP only; the header and the token never reach the log.
      opts.log.debug?.(`mcp auth failed ip=${safeAddress(req.ip)} reason=${authenticated.reason}`);
      if (authenticated.status === 429) return tooMany(reply, authenticated.retryAfterSec ?? 1);
      return reply
        .header("WWW-Authenticate", 'Bearer realm="knowlify"')
        .code(401)
        .send({ message: "Unauthorized" });
    }

    const envelopeError = envelopeErrorOf(req.body);
    if (envelopeError !== null) return invalidEnvelope(reply, envelopeError);

    // Every message in a batch counts against the token rate, and every write call
    // counts per item, so one HTTP request cannot bypass either ceiling.
    for (const message of messagesOf(req.body)) {
      const token = tokenRate.hit(authenticated.principal.tokenId);
      if (!token.allowed) return tooMany(reply, token.retryAfterSec);
      const tool = callOf(message);
      if (tool !== null && WRITE_TOOL_SET.has(tool)) {
        const write = writeRate.hit(authenticated.principal.tokenId);
        if (!write.allowed) return tooMany(reply, write.retryAfterSec);
      }
    }

    const calls = toolCalls(req.body);
    if (authenticated.principal.scope !== "write_notes" && calls.some((call) => call !== null && WRITE_TOOL_SET.has(call))) {
      // The read handler refuses the call; this line names the scope mismatch for diagnosis.
      opts.log.debug?.(`mcp scope rejected ip=${safeAddress(req.ip)} scope=read`);
    }
    const authInfo = authInfoFor(authenticated.principal, authenticated.token);
    const nodeReq = req.raw as IncomingMessage & { auth?: AuthInfo };
    nodeReq.auth = authInfo;
    const handler = authenticated.principal.scope === "write_notes" ? nodeWrite : nodeRead;
    const record: McpCallRecord = { tool: calls[0] ?? null, resultCount: null };
    const started = Date.now();
    let failed = false;
    reply.hijack();
    try {
      await withMcpCallRecord(record, () => handler(nodeReq, reply.raw, req.body));
    } catch (error) {
      failed = true;
      opts.log.error(error, "mcp request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ message: "Internal server error" }));
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    } finally {
      opts.log.info(JSON.stringify({
        event: "mcp_call",
        tokenId: authenticated.principal.tokenId,
        scope: authenticated.principal.scope,
        tool: record.tool,
        ok: !failed && reply.raw.statusCode < 400,
        ms: Date.now() - started,
        resultCount: record.resultCount,
      }));
    }
  });
}
