import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeProviderRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown> | undefined;
}

export type FakeProviderHandler = (
  request: FakeProviderRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface FakeProvider {
  url: string;
  port: number;
  requests: FakeProviderRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Real HTTP server on an ephemeral loopback port; every request is recorded. */
export async function startFakeProvider(handler: FakeProviderHandler): Promise<FakeProvider> {
  const requests: FakeProviderRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      let json: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = body ? JSON.parse(body) : undefined;
        json = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
      } catch {
        json = undefined;
      }
      const recorded: FakeProviderRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body,
        json,
      };
      requests.push(recorded);
      await handler(recorded, res);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function sseHead(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.flushHeaders();
}

export function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

/** One named SSE event; the type is repeated inside `data` as the API does. */
export function anthropicEvent(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export const anthropicMessageStart = (): string => anthropicEvent("message_start", {
  message: { id: "msg_test", type: "message", role: "assistant", content: [], model: "claude-test" },
});

export const anthropicText = (text: string): string => anthropicEvent("content_block_delta", {
  index: 0,
  delta: { type: "text_delta", text },
});

export const anthropicThinking = (text: string): string => anthropicEvent("content_block_delta", {
  index: 0,
  delta: { type: "thinking_delta", thinking: text },
});

export const anthropicPing = (): string => anthropicEvent("ping");

export const anthropicStop = (stopReason = "end_turn"): string => anthropicEvent("message_delta", {
  delta: { stop_reason: stopReason, stop_sequence: null },
  usage: { output_tokens: 2 },
});

export const anthropicMessageStop = (): string => anthropicEvent("message_stop");

export function writeSse(response: ServerResponse, events: readonly string[]): void {
  sseHead(response);
  for (const event of events) response.write(event);
  response.end();
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Writes one event in pieces with a delay, forcing the client to buffer a partial line. */
export async function writeSplitEvent(response: ServerResponse, event: string, delayMs = 5): Promise<void> {
  const middle = Math.floor(event.length / 2);
  response.write(event.slice(0, middle));
  await wait(delayMs);
  response.write(event.slice(middle));
}
