import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { chatRoutes } from "../src/adapters/http/chat.js";
import { registerHttpCompression, suppressesRequestLogging } from "../src/index.js";
import { createChatFixture, parseSseEvents } from "./chat-helpers.js";

describe("HTTP compression", () => {
  it("never compresses the chat SSE stream", async () => {
    const fixture = createChatFixture();
    const app = Fastify();
    await registerHttpCompression(app);
    await app.register(chatRoutes, { prefix: "/api", chat: fixture.chat });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/chat/messages",
        headers: { "accept-encoding": "gzip", "content-type": "application/json" },
        payload: { message: "What is deep work?", scope: { kind: "library" } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      // Explicit identity: not compressed here, and proxies skip their own compression.
      expect(response.headers["content-encoding"]).toBe("identity");
      const events = parseSseEvents(response.body);
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      await app.close();
      fixture.db.close();
    }
  });

  it("only suppresses request logging for high-frequency routes", () => {
    for (const url of [
      "/api/books/book-1/cover",
      "/api/books/book-1/cover?size=thumb",
      "/api/index/status",
      "/api/scan",
      "/api/scan?x=1",
    ]) {
      expect(suppressesRequestLogging(url)).toBe(true);
    }
    for (const url of ["/api/books", "/api/books?limit=60", "/api/books/book-1", "/api/notes"]) {
      expect(suppressesRequestLogging(url)).toBe(false);
    }
  });
});
