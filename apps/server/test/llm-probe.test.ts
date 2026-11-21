import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAiModelsProbe } from "../src/adapters/llm/OpenAiModelsProbe.js";
import { createGuardedFetch } from "../src/adapters/llm/GuardedFetch.js";
import type { LlmProbeTarget } from "../src/ports/llm-settings.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ base: string; port: number }> {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function target(overrides: Partial<LlmProbeTarget> & Pick<LlmProbeTarget, "url">): LlmProbeTarget {
  return { apiKey: null, model: null, apiStyle: "openai", headers: [], ...overrides };
}

describe("OpenAI-compatible probe", () => {
  it("lists models from /v1/models and normalizes a full chat-completions URL", async () => {
    const paths: string[] = [];
    const { base } = await listen((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, { id: "bad\nid" }, { nope: true }] }));
    });
    const probe = new OpenAiModelsProbe(globalThis.fetch);
    const result = await probe.listModels(target({ url: `${base}/v1/chat/completions`, apiKey: "k" }));
    expect(result).toEqual({ supported: true, models: ["a", "b"] });
    expect(paths).toEqual(["/v1/models"]);
  });

  it("drops model ids that echo the effective or draft api key", async () => {
    const receivedKeys: string[] = [];
    const { base } = await listen((req, res) => {
      const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      receivedKeys.push(key);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: key },
          { id: `prefix-${key}` },
          { id: `${key}-suffix` },
          { id: "safe-model" },
        ],
      }));
    });
    const probe = new OpenAiModelsProbe(globalThis.fetch);

    const effective = await probe.listModels(target({ url: `${base}/v1`, apiKey: "sk-effective-123" }));
    expect(effective).toEqual({ supported: true, models: ["safe-model"] });
    expect(JSON.stringify(effective)).not.toContain("sk-effective-123");

    const draft = await probe.listModels(target({ url: `${base}/v1`, apiKey: "sk-draft-456" }));
    expect(draft).toEqual({ supported: true, models: ["safe-model"] });
    expect(JSON.stringify(draft)).not.toContain("sk-draft-456");

    const status = await probe.testChat(target({
      url: `${base}/v1`,
      apiKey: "sk-effective-123",
      model: "safe-model",
    }));
    expect(status).toMatchObject({ ok: true, modelFound: true });
    expect(JSON.stringify(status)).not.toContain("sk-effective-123");

    const keyAsModel = await probe.testChat(target({
      url: `${base}/v1`,
      apiKey: "sk-draft-456",
      model: "sk-draft-456",
    }));
    expect(keyAsModel).toMatchObject({ ok: true, modelFound: false });
    expect(JSON.stringify(keyAsModel)).not.toContain("sk-draft-456");
    expect(receivedKeys).toEqual([
      "sk-effective-123",
      "sk-draft-456",
      "sk-effective-123",
      "sk-draft-456",
    ]);
  });

  it("drops model ids that echo a rendered or short custom header value", async () => {
    const received: Record<string, string>[] = [];
    const { base } = await listen((req, res) => {
      received.push({
        session: String(req.headers["x-session-id"] ?? ""),
        version: String(req.headers["x-probe-version"] ?? ""),
        short: String(req.headers["x-short"] ?? ""),
        template: String(req.headers["x-template"] ?? ""),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "prefix-header-value-sentinel" },
          { id: "echo-secret" },
          { id: "echo-conversation-knowlify-probe" },
          { id: "echo-prefix-knowlify-probe" },
          { id: "safe-model" },
        ],
      }));
    });
    const headers = [
      { name: "x-session-id", value: "conversation-{{conversationId}}" },
      { name: "x-probe-version", value: "header-value-sentinel" },
      { name: "x-short", value: "secret" },
      { name: "x-template", value: "prefix-{{conversationId}}" },
    ];
    // A long key that shares no substring with the ids keeps this focused on header values.
    const apiKey = "sk-openai-header-filter";
    const probe = new OpenAiModelsProbe(globalThis.fetch);
    const result = await probe.listModels(target({ url: `${base}/v1`, apiKey, headers }));
    expect(result).toEqual({ supported: true, models: ["safe-model"] });
    expect(received).toEqual([{
      session: "conversation-knowlify-probe",
      version: "header-value-sentinel",
      short: "secret",
      template: "prefix-knowlify-probe",
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("header-value-sentinel");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("conversation-knowlify-probe");
    expect(serialized).not.toContain("prefix-knowlify-probe");

    const status = await probe.testChat(target({
      url: `${base}/v1`,
      apiKey,
      model: "secret",
      headers,
    }));
    expect(status).toMatchObject({ ok: true, modelFound: false });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("reports unsupported /models without treating it as a failure", async () => {
    for (const status of [404, 405, 501]) {
      const { base } = await listen((_req, res) => {
        res.writeHead(status);
        res.end("no models here");
      });
      const result = await new OpenAiModelsProbe(globalThis.fetch).listModels(target({ url: `${base}/v1` }));
      expect(result).toEqual({ supported: false, models: [] });
    }
  });

  it("maps auth failures and malformed payloads to fixed codes", async () => {
    const unauthorized = await listen((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "SECRET provider text " + "sk-leak" } }));
    });
    expect((await new OpenAiModelsProbe(globalThis.fetch).listModels(target({
      url: `${unauthorized.base}/v1`,
      apiKey: "k",
    }))).code).toBe("unauthorized");

    const malformed = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json SECRET");
    });
    const result = await new OpenAiModelsProbe(globalThis.fetch).listModels(target({ url: `${malformed.base}/v1` }));
    expect(result).toEqual({ supported: false, models: [], code: "rejected" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("caps the list at 500 ids", async () => {
    const { base } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: Array.from({ length: 600 }, (_, index) => ({ id: `model-${index}` })) }));
    });
    const result = await new OpenAiModelsProbe(globalThis.fetch).listModels(target({ url: `${base}/v1` }));
    expect(result.supported).toBe(true);
    expect(result.models).toHaveLength(500);
    expect(new Set(result.models).size).toBe(500);
  });

  it("rejects an oversized model list without forwarding provider text", async () => {
    const { base } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [], pad: "SECRET".repeat(200_000) }));
    });
    const result = await new OpenAiModelsProbe(globalThis.fetch).listModels(target({ url: `${base}/v1` }));
    expect(result).toEqual({ supported: false, models: [], code: "rejected" });
  });

  it("tests the connection without spending tokens when /models works", async () => {
    const { base } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    const probe = new OpenAiModelsProbe(globalThis.fetch);
    await expect(probe.testChat(target({ url: `${base}/v1`, apiKey: "k", model: "m" })))
      .resolves.toMatchObject({ ok: true, modelFound: true });
    await expect(probe.testChat(target({ url: `${base}/v1`, apiKey: "k", model: "other" })))
      .resolves.toMatchObject({ ok: true, modelFound: false });
    const noModel = await probe.testChat(target({ url: `${base}/v1`, apiKey: "k" }));
    expect(noModel.ok).toBe(true);
    expect(noModel).not.toHaveProperty("modelFound");
  });

  it("falls back to a one-token chat completion only when /models is unsupported and a model exists", async () => {
    const chatBodies: Record<string, unknown>[] = [];
    const { base } = await listen(async (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      chatBodies.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    });
    const probe = new OpenAiModelsProbe(globalThis.fetch);
    const noModel = await probe.testChat(target({ url: `${base}/v1`, apiKey: null }));
    expect(noModel.ok).toBe(true);
    expect(chatBodies).toHaveLength(0);

    const result = await probe.testChat(target({ url: `${base}/v1`, apiKey: null, model: "m" }));
    expect(result).toMatchObject({ ok: true, modelFound: true });
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ model: "m", max_tokens: 1, stream: false });
  });

  it("maps chat fallback failures to fixed codes and never echoes the provider body", async () => {
    const { base } = await listen(async (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(404);
        res.end();
        return;
      }
      await readBody(req);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "SECRET provider echo sk-secret" } }));
    });
    const result = await new OpenAiModelsProbe(globalThis.fetch).testChat(target({
      url: `${base}/v1`,
      apiKey: "sk-secret",
      model: "m",
    }));
    expect(result).toMatchObject({ ok: false, code: "rejected" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("maps timeouts and blocked destinations to codes", async () => {
    const timingOut = new OpenAiModelsProbe(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await timingOut.testChat(target({ url: "https://api.example.com/v1", model: "m" })))
      .toMatchObject({ ok: false, code: "timeout" });

    const { base, port } = await listen((_req, res) => res.end("should not run"));
    const guarded = createGuardedFetch({
      policy: { mode: "off" },
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const blocked = await new OpenAiModelsProbe(guarded).testChat(target({
      url: `http://localhost:${port}/v1`,
      model: "m",
    }));
    expect(blocked).toMatchObject({ ok: false, code: "blocked" });
    expect(base).toContain("127.0.0.1");
  });
});
