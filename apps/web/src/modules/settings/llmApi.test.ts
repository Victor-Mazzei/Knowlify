import { describe, expect, it } from "vitest";
import { createLlmApi, probeMessage } from "./llmApi";

/** Shape returned by the real PUT /settings/llm route (`LlmSettings.update()`). */
const connectionResponse = {
  source: "db",
  locked: false,
  enabled: true,
  url: "https://api.deepseek.com/v1",
  model: "deepseek-v4.1-flash",
  hasKey: true,
  keyState: "set",
  maxTokens: 1024,
  timeoutSec: 120,
  ratePerMin: 20,
  defaults: { maxTokens: 1024, timeoutSec: 120, ratePerMin: 20 },
  policy: { allowPrivate: "off", publicRequiresHttps: true },
} as const;

const prompt = {
  custom: null,
  default: "You are a patient tutor.",
  version: "feynman-2",
  maxChars: 4000,
  locked: false,
} as const;

const respond = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("LLM settings API contract", () => {
  it("accepts the PUT /settings/llm response without prompt", async () => {
    const client = createLlmApi(respond(connectionResponse));

    await expect(client.save({ url: "https://api.deepseek.com/v1" })).resolves.toEqual(connectionResponse);
  });

  it("accepts the additive API-style and header fields", async () => {
    const extended = {
      ...connectionResponse,
      apiStyle: "anthropic",
      headers: [{ name: "x-session-id", hasValue: true }],
      headersState: "set",
    };
    const client = createLlmApi(respond(extended));

    await expect(client.save({ url: "https://api.deepseek.com/v1" })).resolves.toEqual(extended);
  });

  it("rejects malformed header views", async () => {
    const client = createLlmApi(
      respond({ ...connectionResponse, headers: [{ name: "x-session-id", hasValue: "yes" }] }),
    );

    await expect(client.save({ url: "https://api.deepseek.com/v1" })).rejects.toThrow(
      "The server sent an unexpected response.",
    );
  });

  it("requires prompt in the GET /settings/llm response", async () => {
    const client = createLlmApi(respond(connectionResponse));

    await expect(client.get()).rejects.toThrow("The server sent an unexpected response.");
  });

  it("reads the persona from the GET /settings/llm response", async () => {
    const client = createLlmApi(respond({ ...connectionResponse, prompt }));

    await expect(client.get()).resolves.toEqual({ ...connectionResponse, prompt });
  });

  it("uses the API style in the not-found probe message", () => {
    expect(probeMessage("not_found", "openai")).toBe("No OpenAI-compatible API was found at this URL.");
    expect(probeMessage("not_found", "anthropic")).toBe("No Anthropic Messages API was found at this URL.");
  });
});
