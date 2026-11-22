import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { buildApp } from "../src/index.js";

const apps: { app: FastifyInstance; db: Db }[] = [];

afterEach(async () => {
  for (const { app, db } of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
    db.close();
  }
});

async function makeApp(): Promise<FastifyInstance> {
  const db = openDb(":memory:");
  const { app } = await buildApp(db, false);
  await app.ready();
  apps.push({ app, db });
  return app;
}

describe("browser CORS preflight", () => {
  it("allows the cross-origin desktop/web request and caches the policy", async () => {
    const app = await makeApp();
    for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://books.example.com"]) {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/api/chat/messages",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-methods"]).toContain("POST");
      expect(String(response.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
      // Without a cache lifetime every authenticated request costs an extra round trip.
      expect(response.headers["access-control-max-age"]).toBe("600");
    }
  });

  it("does not expose CORS on the MCP endpoint", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/mcp",
      headers: { origin: "https://books.example.com", "access-control-request-method": "POST" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
