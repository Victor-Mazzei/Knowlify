import { describe, expect, it } from "vitest";
import { createMockLlmApi } from "./llmMock";
import type { LlmSettingsView } from "./llmTypes";

const put = (body: Record<string, unknown>) =>
  JSON.stringify(body);

describe("llmMock contract", () => {
  it("lists saved header names without exposing their values", async () => {
    const api = createMockLlmApi({ scenario: "headers" });
    const response = await api("/api/settings/llm", {});
    const view = (await response.json()) as LlmSettingsView;

    expect(view.headers).toEqual([{ name: "x-session-id", hasValue: true }]);
    expect(view.headersState).toBe("set");
    expect(JSON.stringify(view)).not.toContain("conversation-42");
  });

  it("marks a scenario as unreadable and disables the client", async () => {
    const api = createMockLlmApi({ scenario: "headers-unreadable" });
    const response = await api("/api/settings/llm", {});
    const view = (await response.json()) as LlmSettingsView;

    expect(view.headersState).toBe("unreadable");
    expect(view.enabled).toBe(false);
    expect(view.headers).toEqual([{ name: "x-session-id", hasValue: true }]);
  });

  it("keeps unreadable names until new values or a clear arrive", async () => {
    const api = createMockLlmApi({ scenario: "headers-unreadable" });
    const response = await api("/api/settings/llm", {
      method: "PUT",
      body: put({ url: "https://api.deepseek.com/v1", model: "deepseek-chat" }),
    });
    const view = (await response.json()) as LlmSettingsView;

    expect(view.headers).toEqual([{ name: "x-session-id", hasValue: true }]);
    expect(view.headersState).toBe("unreadable");
    expect(view.enabled).toBe(false);
  });

  it("rejects a header managed by the selected style", async () => {
    const api = createMockLlmApi({ scenario: "configured" });

    await expect(
      api("/api/settings/llm", {
        method: "PUT",
        body: put({
          url: "https://api.deepseek.com/v1",
          apiStyle: "anthropic",
          headers: [{ name: "x-api-key", value: "secret" }],
        }),
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_header",
      details: { field: "name" },
    });
  });

  it("accepts explicit header values on a new origin", async () => {
    const api = createMockLlmApi({ scenario: "headers" });
    const response = await api("/api/settings/llm", {
      method: "PUT",
      body: put({
        url: "https://other.example/v1",
        apiKey: "sk-new",
        headers: [{ name: "x-session-id", value: "fresh-value" }],
      }),
    });
    const view = (await response.json()) as LlmSettingsView;

    expect(view.url).toBe("https://other.example/v1");
    expect(view.headers).toEqual([{ name: "x-session-id", hasValue: true }]);
    expect(view.headersState).toBe("set");
    expect(JSON.stringify(view)).not.toContain("fresh-value");
  });

  it("rejects every Accept* header and control characters in values", async () => {
    const api = createMockLlmApi({ scenario: "configured" });
    const save = (name: string, value: string) =>
      api("/api/settings/llm", {
        method: "PUT",
        body: put({
          url: "https://api.deepseek.com/v1",
          headers: [{ name, value }],
        }),
      });

    await expect(save("Accept-Language", "en")).rejects.toMatchObject({
      status: 400,
      code: "invalid_header",
      details: { field: "name" },
    });
    await expect(save("x-trace", "\r\nsecret")).rejects.toMatchObject({
      status: 400,
      code: "invalid_header",
      details: { field: "value" },
    });
    await expect(save("x-trace", "secret\r\n")).rejects.toMatchObject({
      status: 400,
      code: "invalid_header",
      details: { field: "value" },
    });
    await expect(save("x-trace", "\r\n")).rejects.toMatchObject({
      status: 400,
      code: "invalid_header",
      details: { field: "value" },
    });
  });

  it("reports the failing field on probe header rejections too", async () => {
    const api = createMockLlmApi({ scenario: "configured" });

    await expect(
      api("/api/settings/llm/models", {
        method: "POST",
        body: put({ headers: [{ name: "x-trace", value: "{{unknown}}" }] }),
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_header",
      details: { field: "value" },
    });
  });

  it("requires a value when the origin changes and a saved name is kept", async () => {
    const api = createMockLlmApi({ scenario: "headers" });

    await expect(
      api("/api/settings/llm", {
        method: "PUT",
        body: put({
          url: "https://other.example/v1",
          apiKey: "sk-new",
          headers: [{ name: "x-session-id" }],
        }),
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "header_value_required",
      details: { field: "value" },
    });
  });

  it("keeps a saved value for the same origin without returning it", async () => {
    const api = createMockLlmApi({ scenario: "headers" });
    const response = await api("/api/settings/llm", {
      method: "PUT",
      body: put({
        url: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        headers: [{ name: "x-session-id" }],
      }),
    });
    const saved = (await response.json()) as LlmSettingsView;

    expect(saved.headers).toEqual([{ name: "x-session-id", hasValue: true }]);
    expect(JSON.stringify(saved)).not.toContain("conversation-42");
  });
});
