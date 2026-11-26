import { useMemo } from "react";
import { consumePairingFragment } from "../modules/settings/share/pairing";
import type { Credentials } from "../types";

const BASE = (window.__KNOWLIFY__?.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");
const STORAGE_KEY = "knowlify-credentials";
/** Mirror the server's credential bounds; anything larger cannot authenticate and is discarded. */
const MAX_USER_LENGTH = 200;
const MAX_PASS_LENGTH = 1000;
/**
 * Basic auth is base64 over UTF-8 bytes: the server decodes the header as UTF-8, while
 * `btoa` alone throws for any character above U+00FF (common in names and passwords).
 */
function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export const basicAuth = (credentials: Credentials) => `Basic ${base64Utf8(`${credentials.user}:${credentials.pass}`)}`;
async function authorizedFetch(credentials: Credentials, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", basicAuth(credentials));
  return fetch(`${BASE}${path}`, { ...init, headers });
}
const isCredentials = (value: unknown): value is Credentials =>
  typeof value === "object" &&
  value !== null &&
  "user" in value &&
  "pass" in value &&
  typeof value.user === "string" &&
  value.user.length <= MAX_USER_LENGTH &&
  typeof value.pass === "string" &&
  value.pass.length <= MAX_PASS_LENGTH;
export function readCredentials(): Credentials | null {
  if (window.__KNOWLIFY__) {
    const injected = window.__KNOWLIFY__.credentials;
    return isCredentials(injected) ? injected : null;
  }
  // A sign-in link from the share QR code wins once; the fragment is removed
  // before the first render, so the password never becomes a bookmark.
  const paired = consumePairingFragment(saveCredentials);
  if (paired) return paired;
  let stored: string | null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage is unavailable (for example, blocked by the browser): ask for sign-in.
    return null;
  }
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (isCredentials(value)) return value;
  } catch {
    // Corrupt JSON falls through to the same cleanup as a valid but unexpected shape.
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Keeping the unusable item is harmless; the next read will reject it again.
  }
  return null;
}
/**
 * Signing out must still complete when storage is blocked; there is nothing to
 * remove in that case.
 */
export const clearCredentials = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Blocked storage has nothing to remove.
  }
};
export const saveCredentials = (credentials: Credentials) => localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
export type AccountInfo = { user: string; canChangePassword: boolean; passwordSource: "env" | "user" };
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Server error code (`tag_name_taken`, `selection_changed`...). */
    public readonly code?: string,
    /** Parsed error body, for fields like the current selection total. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
/** 403 from the network guard: the route only works from the computer running Knowlify. */
export type LocalOnlyError = ApiError & { status: 403; code: "local_only" };
export const LOCAL_ONLY_MESSAGE = "This action is only available on the computer that runs Knowlify.";
export const isLocalOnlyError = (error: unknown): error is LocalOnlyError =>
  error instanceof ApiError && error.status === 403 && error.code === "local_only";
export function formatError(error: unknown) {
  if (isLocalOnlyError(error)) return LOCAL_ONLY_MESSAGE;
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
/** Reads `{ message, code, ...detail }` from a failed response without throwing a second error. */
export async function parseApiError(response: Response): Promise<ApiError> {
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  let details: Record<string, unknown> | undefined;
  try {
    const text = await response.text();
    if (text) {
      try {
        const body: unknown = JSON.parse(text);
        if (typeof body === "object" && body !== null) {
          details = body as Record<string, unknown>;
          if ("message" in body && typeof body.message === "string") message = body.message;
          if ("code" in body && typeof body.code === "string") code = body.code;
        }
      } catch {
        // Plain-text errors (reverse proxies, old routes) keep their body as the message.
        message = text;
      }
    }
  } catch {
    /* keep the status fallback */
  }
  return new ApiError(response.status, message, code, details);
}

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as T;
}
async function accountRequest(credentials: Credentials, path: string, init: RequestInit, onUnauthorized: () => void) {
  const response = await authorizedFetch(credentials, path, init);
  if (response.status === 401) { onUnauthorized(); throw new ApiError(401, "Your session expired. Please sign in again."); }
  if (response.ok) return response;
  // Keep `code` and detail fields so the UI can explain a local-only 403.
  throw await parseApiError(response);
}
export async function getAccount(credentials: Credentials, onUnauthorized: () => void): Promise<AccountInfo> {
  return (await accountRequest(credentials, "/api/account", {}, onUnauthorized)).json() as Promise<AccountInfo>;
}
export async function changePassword(credentials: Credentials, body: { current: string; next: string }, onUnauthorized: () => void) {
  await accountRequest(credentials, "/api/account/password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, onUnauthorized);
}
export async function verifyCredentials(credentials: Credentials) {
  // Probe one id instead of the whole library: auth runs before routing, so a 404
  // for the fake id still proves the credentials (and stays compatible with old servers).
  const response = await authorizedFetch(credentials, "/api/books/__auth-check__");
  if (response.status === 401) throw new Error("Incorrect username or password.");
  if (response.status === 200 || response.status === 204 || response.status === 404) return;
  throw new Error(`Could not open library (${response.status}).`);
}
type ApiFunction = (path: string, init?: RequestInit) => Promise<Response>;

/** Text chunks of one streaming response; `cancel` stops the request. */
export type StreamReader = {
  read(): Promise<{ done: boolean; value?: string }>;
  cancel(): Promise<void>;
};

export type StreamTransport = (path: string, init: RequestInit) => StreamReader;

const streamTransports = new WeakMap<ApiFunction, StreamTransport>();

/** The transport registered for this exact api function, when this browser needs one. */
export function streamFor(api: ApiFunction): StreamTransport | undefined {
  return streamTransports.get(api);
}

/**
 * WebKit 26.x can hold `fetch` ReadableStream chunks until the next network write
 * (webkit.org/b/322545), which leaves a silent chat stream stuck. XHR does not use
 * that path, so only that engine version gets the XHR transport; 27+ keeps fetch.
 */
export function needsXhrStream(userAgent: string): boolean {
  if (!userAgent.includes("AppleWebKit/")) return false;
  if (/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\//.test(userAgent)) return false;
  const version = /Version\/(\d+)/.exec(userAgent);
  if (!version) return false;
  const major = Number(version[1]);
  return major >= 26 && major < 27;
}

/** Mirrors `parseApiError` for an XHR, whose body is already text. */
function xhrError(request: XMLHttpRequest): ApiError {
  const status = request.status;
  const text = request.responseText;
  let message = status ? `Request failed (${status})` : "Could not reach the server.";
  let code: string | undefined;
  let details: Record<string, unknown> | undefined;
  if (text) {
    try {
      const body: unknown = JSON.parse(text);
      if (typeof body === "object" && body !== null) {
        details = body as Record<string, unknown>;
        if ("message" in body && typeof body.message === "string") message = body.message;
        if ("code" in body && typeof body.code === "string") code = body.code;
      }
    } catch {
      message = text;
    }
  }
  return new ApiError(status, message, code, details);
}

function createXhrTransport(credentials: Credentials, onUnauthorized: () => void): StreamTransport {
  return (path, init) => {
    let request: XMLHttpRequest | undefined;
    let settled = false;
    const stream = new ReadableStream<string>({
      start(controller) {
        const xhr = new XMLHttpRequest();
        request = xhr;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          controller.error(error);
        };
        let offset = 0;
        const drain = () => {
          if (settled) return;
          const text = xhr.responseText.slice(offset);
          offset = xhr.responseText.length;
          if (text) controller.enqueue(text);
        };
        xhr.open(init.method ?? "GET", `${BASE}${path}`);
        const headers = new Headers(init.headers);
        headers.set("Authorization", basicAuth(credentials));
        headers.forEach((value, key) => xhr.setRequestHeader(key, value));
        // SSE is UTF-8; do not let XHR guess the charset from the MIME type.
        xhr.overrideMimeType("text/plain; charset=utf-8");
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 2 || xhr.status !== 401) return;
          onUnauthorized();
          fail(new Error("Your session expired. Please sign in again."));
          xhr.abort();
        };
        xhr.onprogress = () => {
          if (xhr.status >= 200 && xhr.status < 300) drain();
        };
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) {
            fail(xhrError(xhr));
            return;
          }
          drain();
          if (settled) return;
          settled = true;
          controller.close();
        };
        xhr.onerror = () => fail(new Error("Could not reach the server."));
        xhr.ontimeout = () => fail(new Error("The connection timed out."));
        xhr.onabort = () => fail(new DOMException("The operation was aborted.", "AbortError"));
        const signal = init.signal;
        if (signal?.aborted) {
          fail(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        const body = init.body;
        try {
          if (body === undefined || body === null) xhr.send();
          else if (typeof body === "string") xhr.send(body);
          else if (body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams || body instanceof ArrayBuffer)
            xhr.send(body);
          else if (ArrayBuffer.isView(body)) xhr.send(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
          else fail(new Error("This request body cannot be streamed."));
        } catch (error) {
          fail(error);
        }
      },
      cancel() {
        settled = true;
        request?.abort();
      },
    });
    return stream.getReader();
  };
}

export function useApi(credentials: Credentials, onUnauthorized: () => void) {
  const transport = useMemo(
    () =>
      typeof navigator !== "undefined" && needsXhrStream(navigator.userAgent)
        ? createXhrTransport(credentials, onUnauthorized)
        : undefined,
    [credentials, onUnauthorized],
  );
  return useMemo(() => {
    const api: ApiFunction = async (path, init = {}) => {
      const response = await authorizedFetch(credentials, path, init);
      if (response.status === 401) { onUnauthorized(); throw new Error("Your session expired. Please sign in again."); }
      // Error responses must keep `code` and the detail fields the UI depends on
      // (`selection_changed` totals, `notes_confirmation_required` counts).
      if (!response.ok) throw await parseApiError(response);
      return response;
    };
    if (transport) streamTransports.set(api, transport);
    return api;
  }, [credentials, onUnauthorized, transport]);
}
export { STORAGE_KEY };
