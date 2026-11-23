import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
const apps: { app: FastifyInstance; db: Db }[] = [];

afterEach(async () => {
  for (const { app, db } of apps.splice(0)) {
    await app.close();
    db.close();
  }
});

async function makeApp() {
  const db = openDb(":memory:");
  const { app } = await buildApp(db, false);
  await app.ready();
  apps.push({ app, db });
  return app;
}

describe("GET /api/chat/status", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/chat/status" });
    expect(response.statusCode).toBe(401);
  });

  it("reports the frozen disabled shape without leaking a provider URL or key", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/chat/status", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      "enabled",
      "features",
      "host",
      "model",
      "modes",
      "promptVersion",
      "scopes",
      "sessionLimits",
    ]);
    expect(body).toEqual({
      enabled: false,
      model: null,
      host: null,
      promptVersion: "feynman-5",
      scopes: { library: false, book: false },
      modes: ["ask", "session"],
      features: { recommendations: true },
      sessionLimits: { maxSessions: 200, count: 0, maxMessages: 100 },
    });
    expect(response.body).not.toMatch(/https?:\/\/|api[_-]?key|secret/i);
  });
});
