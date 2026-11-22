import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { basicAuth, needsXhrStream, streamFor, useApi } from "./api";

const SAFARI_26 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15";
const SAFARI_27 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";
const CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0";

class FakeXhr {
  static instances: FakeXhr[] = [];
  readyState = 0;
  status = 0;
  responseText = "";
  method = "";
  url = "";
  body: unknown = null;
  headers = new Map<string, string>();
  aborted = false;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onreadystatechange: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  overrideMimeType() {}
  send(body?: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  receiveHeaders(status: number) {
    this.status = status;
    this.readyState = 2;
    this.onreadystatechange?.();
  }
  receiveText(text: string) {
    this.responseText += text;
    this.onprogress?.();
  }
  load() {
    this.readyState = 4;
    this.onload?.();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
});

const renderSafari = (userAgent = SAFARI_26) => {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
  const onUnauthorized = vi.fn();
  const { result } = renderHook(() => useApi({ user: "reader", pass: "secret" }, onUnauthorized));
  return { api: result.current, onUnauthorized };
};

describe("needsXhrStream", () => {
  it("targets WebKit 26.x only", () => {
    expect(needsXhrStream(SAFARI_26)).toBe(true);
    expect(needsXhrStream(SAFARI_27)).toBe(false);
    expect(needsXhrStream(CHROME)).toBe(false);
    expect(needsXhrStream(FIREFOX)).toBe(false);
    expect(needsXhrStream("Mozilla/5.0 AppleWebKit/605.1.15 Safari/605.1.15")).toBe(false);
  });
});

describe("XHR chat transport", () => {
  it("streams decoded text chunks with the same auth, body and headers", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const { api } = renderSafari();
    const transport = streamFor(api);
    expect(transport).toBeDefined();

    const reader = transport!("/api/chat/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const xhr = FakeXhr.instances[FakeXhr.instances.length - 1]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/chat/messages");
    expect(xhr.body).toBe(JSON.stringify({ message: "hi" }));
    // Headers.forEach yields the normalized lowercase names XHR would receive.
    expect(xhr.headers.get("authorization")).toBe(basicAuth({ user: "reader", pass: "secret" }));
    expect(xhr.headers.get("content-type")).toBe("application/json");

    xhr.receiveHeaders(200);
    xhr.receiveText('data: {"type":"delta","text":"Hel');
    await expect(reader.read()).resolves.toEqual({ done: false, value: 'data: {"type":"delta","text":"Hel' });
    xhr.receiveText('lo"}\n\n');
    await expect(reader.read()).resolves.toEqual({ done: false, value: 'lo"}\n\n' });
    xhr.load();
    await expect(reader.read()).resolves.toEqual({ done: true });
  });

  it("turns a non-2xx response into an ApiError with the server code", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const { api } = renderSafari();
    const reader = streamFor(api)!("/api/chat/messages", { method: "POST", body: "{}" });
    const xhr = FakeXhr.instances[FakeXhr.instances.length - 1]!;

    xhr.receiveHeaders(500);
    xhr.responseText = JSON.stringify({ message: "Boom", code: "llm_unavailable", host: "api.example" });
    xhr.load();
    await expect(reader.read()).rejects.toMatchObject({
      status: 500,
      message: "Boom",
      code: "llm_unavailable",
      details: { message: "Boom", code: "llm_unavailable", host: "api.example" },
    });
  });

  it("signs out on 401 and fails the stream", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const { api, onUnauthorized } = renderSafari();
    const reader = streamFor(api)!("/api/chat/messages", { method: "POST", body: "{}" });
    const xhr = FakeXhr.instances[FakeXhr.instances.length - 1]!;

    xhr.receiveHeaders(401);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(xhr.aborted).toBe(true);
    await expect(reader.read()).rejects.toThrow("Your session expired. Please sign in again.");
  });

  it("aborts the request through the caller signal and through reader.cancel", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const { api } = renderSafari();
    const transport = streamFor(api)!;
    const controller = new AbortController();
    const aborted = transport("/api/chat/messages", { method: "POST", body: "{}", signal: controller.signal });
    const first = FakeXhr.instances[FakeXhr.instances.length - 1]!;
    controller.abort();
    expect(first.aborted).toBe(true);
    await expect(aborted.read()).rejects.toMatchObject({ name: "AbortError" });

    const cancelled = transport("/api/chat/messages", { method: "POST", body: "{}" });
    const second = FakeXhr.instances[FakeXhr.instances.length - 1]!;
    await cancelled.cancel();
    expect(second.aborted).toBe(true);
  });

  it("keeps fetch for WebKit 27+", () => {
    const { api } = renderSafari(SAFARI_27);
    expect(streamFor(api)).toBeUndefined();
  });
});
