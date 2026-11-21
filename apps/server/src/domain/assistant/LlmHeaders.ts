import {
  LLM_API_STYLE_PROFILES,
  type LlmApiStyle,
} from "./LlmApiStyle.js";
import { LlmSettingsError, type LlmHeaderErrorField } from "./LlmSettingsError.js";

export const MAX_LLM_HEADERS = 8;
export const MAX_LLM_HEADER_NAME_CHARS = 64;
export const MAX_LLM_HEADER_VALUE_CHARS = 512;
/** Names plus values; ASCII-only values make characters equal to bytes. */
export const MAX_LLM_HEADER_TOTAL_CHARS = 3 * 1024;
export const HEADER_CONVERSATION_VARIABLE = "{{conversationId}}";

/** Value sent instead of a real conversation id by the read-only probes. */
export const PROBE_CONVERSATION_ID = "knowlify-probe";

export interface LlmHeaderInput {
  name: string;
  /** Omitted means "keep the stored value" (same origin and existing name only). */
  value?: string;
}

/** Resolved pair. `value` is a secret: never log it, return it or put it in an error. */
export interface LlmHeaderStored {
  name: string;
  value: string;
}

export interface LlmHeaderView {
  name: string;
  hasValue: boolean;
}

/** RFC 7230 token, the only shape a header name may take. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Visible ASCII plus space: no CR/LF, no controls, no non-ASCII (header injection). */
const HEADER_VALUE = /^[\x20-\x7e]+$/;

/**
 * Hop-by-hop and request-framing headers are fixed by `fetch`/the protocol; cookies and
 * `authorization` are not user-controlled (the API key owns the credential header).
 */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "content-type",
  "content-encoding",
  "accept",
  "accept-encoding",
  "cookie",
  "set-cookie",
  "authorization",
]);

/** Validates the ORIGINAL text before any trim: CR, LF, HTAB, controls and non-ASCII are always rejected. */
const VISIBLE_ASCII_ONLY = /^[\x20-\x7e]+$/;

function invalidHeader(message: string, field?: LlmHeaderErrorField): LlmSettingsError {
  return new LlmSettingsError("invalid_header", 400, message, undefined, field);
}

function headerValueRequired(name: string): LlmSettingsError {
  return new LlmSettingsError(
    "header_value_required",
    400,
    `A value is required for the header "${name}"`,
    undefined,
    "value",
  );
}

export function normalizeLlmHeaderName(raw: unknown): string {
  if (typeof raw !== "string") throw invalidHeader("The header name is not valid", "name");
  // Reject controls before trimming: `"\r\nX"` must fail, never become `"X"`.
  if (!VISIBLE_ASCII_ONLY.test(raw)) throw invalidHeader("The header name is not valid", "name");
  const name = raw.replace(/^ +| +$/g, "");
  if (name.length === 0 || name.length > MAX_LLM_HEADER_NAME_CHARS || !HEADER_NAME.test(name)) {
    throw invalidHeader("The header name is not valid", "name");
  }
  return name;
}

export function isLlmHeaderNameForbidden(name: string, style: LlmApiStyle): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(":") || lower.startsWith("proxy-") || lower.startsWith("sec-")) return true;
  // `Accept*` is managed by the transport (content negotiation), in every style.
  if (lower.startsWith("accept")) return true;
  if (FORBIDDEN_HEADERS.has(lower)) return true;
  return LLM_API_STYLE_PROFILES[style].managedHeaders.includes(lower);
}

export function assertLlmHeaderAllowed(rawName: unknown, style: LlmApiStyle): string {
  const name = normalizeLlmHeaderName(rawName);
  if (isLlmHeaderNameForbidden(name, style)) {
    throw invalidHeader(`The header "${name}" cannot be set`, "name");
  }
  return name;
}

export function normalizeLlmHeaderValue(raw: unknown, name: string): string {
  if (typeof raw !== "string") {
    throw invalidHeader(`The value of the header "${name}" is not valid`, "value");
  }
  // Validate the original value first: trimming must never hide CR/LF or other controls.
  if (!VISIBLE_ASCII_ONLY.test(raw)) {
    throw invalidHeader(`The value of the header "${name}" is not valid`, "value");
  }
  const value = raw.replace(/^ +| +$/g, "");
  if (value.length === 0 || value.length > MAX_LLM_HEADER_VALUE_CHARS) {
    throw invalidHeader(`The value of the header "${name}" is not valid`, "value");
  }
  assertLlmHeaderTemplate(value, name);
  return value;
}

/**
 * The only supported variable is `{{conversationId}}`, written exactly. Any other brace
 * sequence is a typo: rejecting it prevents a silently literal header value.
 */
export function assertLlmHeaderTemplate(value: string, name: string): void {
  const withoutVariable = value.split(HEADER_CONVERSATION_VARIABLE).join("");
  if (/[{}]/.test(withoutVariable)) {
    throw invalidHeader(
      `The value of the header "${name}" has an unknown variable; only {{conversationId}} is allowed`,
      "value",
    );
  }
}

/** Validates a resolved list, including style-owned names (used when keeping or switching styles). */
export function normalizeLlmHeaderList(
  headers: readonly LlmHeaderStored[],
  style: LlmApiStyle,
): LlmHeaderStored[] {
  if (headers.length > MAX_LLM_HEADERS) {
    throw invalidHeader(`At most ${MAX_LLM_HEADERS} custom headers are allowed`, "name");
  }
  const seen = new Set<string>();
  const normalized: LlmHeaderStored[] = [];
  let total = 0;
  for (const header of headers) {
    const name = assertLlmHeaderAllowed(header.name, style);
    const key = name.toLowerCase();
    if (seen.has(key)) throw invalidHeader(`The header "${name}" is repeated`, "name");
    seen.add(key);
    const value = normalizeLlmHeaderValue(header.value, name);
    total += name.length + value.length;
    if (total > MAX_LLM_HEADER_TOTAL_CHARS) {
      throw invalidHeader("The custom headers are too large", "name");
    }
    normalized.push({ name, value });
  }
  return normalized;
}

/**
 * Applies the origin rule (D3). A value-less item keeps the stored value only for the
 * same origin and an existing name; renaming always requires a new value.
 */
export function mergeLlmHeaders(
  input: readonly LlmHeaderInput[],
  existing: readonly LlmHeaderStored[],
  options: { sameOrigin: boolean; style: LlmApiStyle },
): LlmHeaderStored[] {
  if (!Array.isArray(input)) throw invalidHeader("The custom headers are not valid", "name");
  if (input.length > MAX_LLM_HEADERS) {
    throw invalidHeader(`At most ${MAX_LLM_HEADERS} custom headers are allowed`, "name");
  }
  const stored = new Map(existing.map((header) => [header.name.toLowerCase(), header]));
  const merged: LlmHeaderStored[] = [];
  for (const item of input) {
    const name = assertLlmHeaderAllowed(item.name, options.style);
    if (item.value === undefined) {
      const previous = options.sameOrigin ? stored.get(name.toLowerCase()) : undefined;
      if (!previous) throw headerValueRequired(name);
      merged.push({ name, value: previous.value });
      continue;
    }
    merged.push({ name, value: normalizeLlmHeaderValue(item.value, name) });
  }
  return normalizeLlmHeaderList(merged, options.style);
}

/**
 * Parses `KNOWLIFY_LLM_HEADERS` (one JSON object). Errors name the offending header but
 * never repeat a value or the raw JSON.
 */
export function parseLlmHeadersEnv(raw: string, style: LlmApiStyle): LlmHeaderStored[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("KNOWLIFY_LLM_HEADERS is not a valid JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("KNOWLIFY_LLM_HEADERS must be a JSON object");
  }
  const headers: LlmHeaderStored[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (headers.length >= MAX_LLM_HEADERS) {
      throw new Error(`KNOWLIFY_LLM_HEADERS has more than ${MAX_LLM_HEADERS} headers`);
    }
    if (typeof value !== "string") {
      throw new Error(`KNOWLIFY_LLM_HEADERS has a non-string value for a header`);
    }
    try {
      headers.push({ name: assertLlmHeaderAllowed(name, style), value: normalizeLlmHeaderValue(value, name) });
    } catch (error) {
      throw new Error(error instanceof LlmSettingsError ? error.message : "KNOWLIFY_LLM_HEADERS is not valid");
    }
  }
  try {
    return normalizeLlmHeaderList(headers, style);
  } catch (error) {
    throw new Error(error instanceof LlmSettingsError ? error.message : "KNOWLIFY_LLM_HEADERS is not valid");
  }
}

/**
 * Renders the resolved list for a request. A value that depends on the conversation is
 * omitted when there is no conversation id (same behaviour the fixed header had).
 */
export function renderLlmHeaders(
  headers: readonly LlmHeaderStored[],
  vars: { conversationId?: string },
): Record<string, string> {
  // Null prototype: a header literally named `__proto__` is a normal own key, never the prototype.
  const rendered: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const header of headers) {
    let value = header.value;
    if (value.includes(HEADER_CONVERSATION_VARIABLE)) {
      if (!vars.conversationId) continue;
      value = value.split(HEADER_CONVERSATION_VARIABLE).join(vars.conversationId);
    }
    if (value.length > MAX_LLM_HEADER_VALUE_CHARS || !HEADER_VALUE.test(value)) {
      throw invalidHeader(`The value of the header "${header.name}" is not valid after rendering`, "value");
    }
    rendered[header.name.toLowerCase()] = value;
  }
  return rendered;
}

/**
 * Rebuilds the ordered value list from the decrypted JSON. Any missing, extra or invalid
 * entry makes the whole set unreadable: a mismatched list must not half-apply, and a
 * tampered name must never override a style-managed header.
 */
export function readStoredLlmHeaders(
  decrypted: unknown,
  names: readonly string[],
  style: LlmApiStyle,
): LlmHeaderStored[] | null {
  if (typeof decrypted !== "object" || decrypted === null || Array.isArray(decrypted)) return null;
  const record = decrypted as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== names.length) return null;
  try {
    const ordered: LlmHeaderStored[] = [];
    for (const name of names) {
      const match = ifindKey(record, name);
      if (match === undefined) return null;
      const value = record[match];
      if (typeof value !== "string") return null;
      ordered.push({ name, value: normalizeLlmHeaderValue(value, name) });
    }
    return normalizeLlmHeaderList(ordered, style);
  } catch {
    return null;
  }
}

function ifindKey(record: Record<string, unknown>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.keys(record).find((key) => key.toLowerCase() === target);
}

/**
 * Values the read-only probes send as custom headers (D8), with `{{conversationId}}`
 * already resolved to the probe value. A provider-controlled model id that contains one
 * of them echoes a value the user asked us to keep secret; short values are not exempt.
 */
export function sensitiveHeaderValues(headers: readonly LlmHeaderStored[]): string[] {
  return Object.values(renderLlmHeaders(headers, { conversationId: PROBE_CONVERSATION_ID }));
}
