import { isIP } from "node:net";
import {
  classify,
  isAddressAllowed,
  type AllowPrivatePolicy,
} from "../net/IpClassification.js";
import { parseLlmApiStyle, type LlmApiStyle } from "./LlmApiStyle.js";
import { assertLlmHeaderAllowed, MAX_LLM_HEADERS, MAX_LLM_HEADER_TOTAL_CHARS } from "./LlmHeaders.js";
import { LlmSettingsError } from "./LlmSettingsError.js";

export { LlmSettingsError } from "./LlmSettingsError.js";
export type { LlmSettingsErrorCode } from "./LlmSettingsError.js";

export const MAX_LLM_URL_CHARS = 2_048;
export const MAX_LLM_MODEL_CHARS = 200;
export const MAX_LLM_KEY_CHARS = 512;
export const MAX_LLM_TOKENS = 32_768;
export const MIN_LLM_TIMEOUT_SEC = 5;
export const MAX_LLM_TIMEOUT_SEC = 600;
export const MAX_LLM_RATE_PER_MIN = 120;

export const LLM_DEFAULTS = {
  maxTokens: 1_024,
  timeoutSec: 120,
  ratePerMin: 20,
} as const;

export interface LlmConfigValues {
  url: string;
  model: string | null;
  maxTokens: number;
  timeoutSec: number;
  ratePerMin: number;
  apiStyle: LlmApiStyle;
  /** Names in clear (the UI lists them); values live in the sealed `llm_headers` blob. */
  headerNames: string[];
}

export interface LlmConfigInput {
  url: string;
  model?: string | null;
  maxTokens?: number;
  timeoutSec?: number;
  ratePerMin?: number;
  apiStyle?: LlmApiStyle;
  headerNames?: readonly string[];
}

function invalid(message: string): LlmSettingsError {
  return new LlmSettingsError("invalid_value", 400, message);
}

export function normalizeLlmUrl(input: string): string {
  const raw = input.trim();
  if (!raw || raw.length > MAX_LLM_URL_CHARS) {
    throw new LlmSettingsError("invalid_url", 400, "The server URL is not valid");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LlmSettingsError("invalid_url", 400, "The server URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LlmSettingsError("invalid_url", 400, "The server URL is not valid");
  }
  if (!url.hostname || url.username || url.password || url.hash || url.search) {
    throw new LlmSettingsError("invalid_url", 400, "The server URL is not valid");
  }
  return url.toString().replace(/\/+$/, "");
}

export function urlOrigin(input: string): string {
  return new URL(input).origin;
}

export function normalizeLlmModel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const model = value.trim();
  if (!model || model.length > MAX_LLM_MODEL_CHARS || /[\u0000-\u001f\u007f]/.test(model)) {
    throw invalid("The model name is not valid");
  }
  return model;
}

/** API keys travel in a header, so only visible ASCII is accepted (no injection). */
export function normalizeLlmApiKey(value: string): string {
  if (!value || value.length > MAX_LLM_KEY_CHARS || !/^[\x21-\x7e]+$/.test(value)) {
    throw invalid("The API key is not valid");
  }
  return value;
}

function readBound(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid("The numeric setting is out of range");
  }
  return value;
}

export function normalizeLlmLimits(input: {
  maxTokens?: unknown;
  timeoutSec?: unknown;
  ratePerMin?: unknown;
}): { maxTokens: number; timeoutSec: number; ratePerMin: number } {
  const numeric = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number") throw invalid("The numeric setting is not valid");
    return value;
  };
  return {
    maxTokens: readBound(numeric(input.maxTokens), LLM_DEFAULTS.maxTokens, 1, MAX_LLM_TOKENS),
    timeoutSec: readBound(numeric(input.timeoutSec), LLM_DEFAULTS.timeoutSec, MIN_LLM_TIMEOUT_SEC, MAX_LLM_TIMEOUT_SEC),
    ratePerMin: readBound(numeric(input.ratePerMin), LLM_DEFAULTS.ratePerMin, 1, MAX_LLM_RATE_PER_MIN),
  };
}

function normalizeHeaderNames(names: readonly string[] | undefined, style: LlmApiStyle): string[] {
  if (names === undefined) return [];
  if (names.length > MAX_LLM_HEADERS) {
    throw new LlmSettingsError("invalid_header", 400, `At most ${MAX_LLM_HEADERS} custom headers are allowed`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  let total = 0;
  for (const name of names) {
    const normalized = assertLlmHeaderAllowed(name, style);
    if (seen.has(normalized.toLowerCase())) {
      throw new LlmSettingsError("invalid_header", 400, `The header "${normalized}" is repeated`);
    }
    seen.add(normalized.toLowerCase());
    total += normalized.length;
    result.push(normalized);
  }
  if (total > MAX_LLM_HEADER_TOTAL_CHARS) {
    throw new LlmSettingsError("invalid_header", 400, "The custom headers are too large");
  }
  return result;
}

export function normalizeLlmConfig(input: LlmConfigInput): LlmConfigValues {
  const limits = normalizeLlmLimits(input);
  const apiStyle = input.apiStyle ?? parseLlmApiStyle(undefined);
  return {
    url: normalizeLlmUrl(input.url),
    model: normalizeLlmModel(input.model),
    ...limits,
    apiStyle,
    headerNames: normalizeHeaderNames(input.headerNames, apiStyle),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("The stored LLM configuration is not valid");
  }
  return value as Record<string, unknown>;
}

export function parseStoredLlmConfig(json: string): LlmConfigValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalid("The stored LLM configuration is not valid");
  }
  const stored = record(parsed);
  if (typeof stored.url !== "string") throw invalid("The stored LLM configuration is not valid");
  const model = stored.model === undefined ? null : stored.model;
  if (model !== null && typeof model !== "string") {
    throw invalid("The stored LLM configuration is not valid");
  }
  let apiStyle: LlmApiStyle;
  try {
    apiStyle = parseLlmApiStyle(stored.apiStyle);
  } catch {
    throw invalid("The stored LLM configuration is not valid");
  }
  let headerNames: string[] | undefined;
  if (stored.headerNames !== undefined) {
    if (!Array.isArray(stored.headerNames) || stored.headerNames.some((name) => typeof name !== "string")) {
      throw invalid("The stored LLM configuration is not valid");
    }
    headerNames = stored.headerNames;
  }
  try {
    return normalizeLlmConfig({
      url: stored.url,
      model,
      maxTokens: stored.maxTokens as number | undefined,
      timeoutSec: stored.timeoutSec as number | undefined,
      ratePerMin: stored.ratePerMin as number | undefined,
      apiStyle,
      headerNames,
    });
  } catch (error) {
    if (error instanceof LlmSettingsError && error.code === "invalid_header") {
      // A header-name problem in a stored row is a corrupted row, not a user input error.
      throw invalid("The stored LLM configuration is not valid");
    }
    throw error;
  }
}

/**
 * A row written before custom headers existed has no `headerNames` key. Only that shape
 * is migrated; a new installation always writes the key, even when the list is empty.
 */
export function storedLlmConfigIsLegacy(json: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && !("headerNames" in parsed);
  } catch {
    return false;
  }
}

export function serializeLlmConfig(config: LlmConfigValues): string {
  return JSON.stringify({
    url: config.url,
    model: config.model,
    maxTokens: config.maxTokens,
    timeoutSec: config.timeoutSec,
    ratePerMin: config.ratePerMin,
    apiStyle: config.apiStyle,
    headerNames: config.headerNames,
  });
}

export type DestinationVerdict = "ok" | "blocked" | "https_required";

function publicRequiresHttps(url: URL): boolean {
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return url.protocol !== "https:" || port !== 443;
}

/**
 * Applies ADR-15 to one resolved address. A public destination must use HTTPS on
 * port 443; loopback/private ranges are only accepted when the operator allows them,
 * and link-local/reserved ranges are never accepted by `on`. Explicit CIDR modes are
 * the operator's responsibility.
 */
export function evaluateDestination(
  url: URL,
  address: string,
  policy: AllowPrivatePolicy,
): DestinationVerdict {
  const kind = classify(address);
  if (!kind) return "blocked";
  if (!isAddressAllowed(address, kind, policy)) return "blocked";
  if (kind === "public" && publicRequiresHttps(url)) return "https_required";
  return "ok";
}

/**
 * Evaluates every address a hostname resolved to: one forbidden address rejects the
 * whole destination (DNS rotation/rebinding cannot hide a private answer).
 */
export function evaluateResolvedDestination(
  url: URL,
  addresses: readonly string[],
  policy: AllowPrivatePolicy,
): DestinationVerdict {
  let httpsRequired = false;
  for (const address of addresses) {
    const verdict = evaluateDestination(url, address, policy);
    if (verdict === "blocked") return "blocked";
    if (verdict === "https_required") httpsRequired = true;
  }
  return httpsRequired ? "https_required" : "ok";
}

export function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}
