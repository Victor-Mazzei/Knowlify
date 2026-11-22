import { GuardedFetchError } from "../llm/GuardedFetch.js";
import {
  knownProviderErrorReason,
  knownProviderErrorStatus,
} from "../../domain/library/ProviderErrorIdentifiers.js";
import type {
  MetadataFailureDetails,
  MetadataLookupErrorCode,
  MetadataLookupFailure,
  MetadataLookupReason,
} from "../../ports/library-metadata.js";

/** An adapter failure with a stable code; the use case turns it into a partial `errors` entry. */
export class MetadataProviderError extends Error implements MetadataLookupFailure {
  readonly code: MetadataLookupErrorCode;
  readonly reason?: MetadataLookupReason;
  readonly status?: number;
  readonly networkCode?: string;
  readonly errorStatus?: string;
  readonly errorReason?: string;

  constructor(code: MetadataLookupErrorCode, details: MetadataFailureDetails = {}) {
    super(`Metadata provider failed (${code})`);
    this.name = "MetadataProviderError";
    this.code = code;
    this.reason = details.reason;
    this.status = details.status;
    this.networkCode = details.networkCode;
    // The provider controls these fields; only the closed allowlist can reach a log.
    this.errorStatus = knownProviderErrorStatus(details.errorStatus);
    this.errorReason = knownProviderErrorReason(details.errorReason);
  }
}

const isFailure = (value: unknown): value is MetadataLookupFailure =>
  typeof value === "object" && value !== null && "code" in value
  && (value as { code?: unknown }).code !== undefined
  && ["rate_limited", "timeout", "unavailable"].includes((value as { code: string }).code);

const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Syntactic token for transport/GuardedFetch codes. Provider body text never goes
 * through here; `error.status` and `details[].reason` use the closed allowlist.
 */
function transportToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return TOKEN.test(token) ? token : undefined;
}

/** Node wraps socket failures in `TypeError.cause`; both shapes are read. */
function networkCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = transportToken((error as { code?: unknown }).code);
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = typeof cause === "object" && cause !== null
    ? transportToken((cause as { code?: unknown }).code)
    : undefined;
  if (direct?.startsWith("UND_ERR_") && causeCode) return causeCode;
  return direct ?? causeCode;
}

/** Maps transport and abort failures without ever exposing an address or provider body. */
export function providerFailure(error: unknown, signal?: AbortSignal): MetadataProviderError {
  if (error instanceof MetadataProviderError) return error;
  // GuardedFetchError also carries a `code`; it must be classified before the generic
  // failure shape, otherwise its timeout/blocked information is lost.
  if (error instanceof GuardedFetchError) {
    const networkCode = transportToken(error.causeCode) ?? transportToken(error.code);
    if (error.code === "timeout") {
      return new MetadataProviderError("timeout", { reason: "timeout", networkCode });
    }
    if (error.code === "blocked" || error.code === "https_required") {
      return new MetadataProviderError("unavailable", { reason: "blocked_destination", networkCode });
    }
    // TLS and socket/DNS failures are transport failures; the specific code is preserved.
    return new MetadataProviderError("unavailable", { reason: "network", networkCode });
  }
  if (isFailure(error)) {
    return new MetadataProviderError(error.code, {
      reason: error.reason,
      status: error.status,
      networkCode: error.networkCode,
      errorStatus: knownProviderErrorStatus(error.errorStatus),
      errorReason: knownProviderErrorReason(error.errorReason),
    });
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (signal?.aborted || name === "AbortError" || name === "TimeoutError") {
    return new MetadataProviderError("timeout", { reason: "timeout" });
  }
  return new MetadataProviderError("unavailable", { reason: "network", networkCode: networkCodeOf(error) });
}

/**
 * Google error identifiers extracted from a response body; its message is never read.
 * Values are restricted to the closed allowlist in `ProviderErrorIdentifiers`.
 */
export interface ProviderErrorDetails {
  errorStatus?: string;
  errorReason?: string;
}

const KEY_REASON = /^(?:API_KEY_(?:INVALID|EXPIRED|NOT_VALID|SERVICE_BLOCKED)|key(?:Invalid|Expired))$/i;
const SERVICE_DISABLED = /^(?:SERVICE_DISABLED|accessNotConfigured)$/i;
const REFERRER_OR_IP_BLOCKED =
  /^(?:API_KEY_(?:HTTP_REFERRER|IP_ADDRESS|ANDROID_APP|IOS_APP)_BLOCKED|IP_REFERER_BLOCKED)$/i;

/**
 * Classifies a non-OK provider response. Only stable identifiers decide between the
 * ambiguous 400/403 cases; without them the status alone is reported.
 */
export function classifyHttpStatus(status: number, details: ProviderErrorDetails = {}): MetadataLookupReason {
  const errorReason = details.errorReason ?? "";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status === 401) return "key_rejected";
  if (status === 400) return KEY_REASON.test(errorReason) ? "key_rejected" : "http_error";
  if (status === 403) {
    if (SERVICE_DISABLED.test(errorReason)) return "service_disabled";
    if (REFERRER_OR_IP_BLOCKED.test(errorReason)) return "referrer_or_ip_blocked";
    if (KEY_REASON.test(errorReason)) return "key_rejected";
    return "forbidden";
  }
  if (status >= 500) return "upstream_error";
  return "http_error";
}

/** HTTP status to a provider failure; `code` keeps the legacy quota bucket (429/503). */
export function statusFailure(status: number, details: ProviderErrorDetails = {}): MetadataProviderError {
  const reason = classifyHttpStatus(status, details);
  const code: MetadataLookupErrorCode = status === 429 || status === 503 ? "rate_limited" : "unavailable";
  return new MetadataProviderError(code, { reason, status, ...details });
}

export const MAX_ERROR_BODY_BYTES = 64 * 1024;

const GENERIC_GOOGLE_REASONS = /^(?:badRequest|forbidden|failedPrecondition)$/i;

/**
 * Reads a non-OK body with a hard 64 KB ceiling and keeps only Google error identifiers
 * from a closed allowlist. The body is cancelled when it is larger, so a provider cannot
 * exhaust memory or stall the request; no free text ever leaves this function.
 *
 * Modern Google responses often put only a generic `errors[].reason` (`badRequest`,
 * `forbidden`) and the actionable identifier (`API_KEY_INVALID`, `SERVICE_DISABLED`,
 * `API_KEY_HTTP_REFERRER_BLOCKED`) in `details[].reason`; a specific detail wins over
 * the generic one so the log names the real cause. `error.message` is never read.
 */
export async function googleErrorDetails(
  response: Response,
  signal?: AbortSignal,
): Promise<ProviderErrorDetails> {
  const text = await readTextCapped(response, MAX_ERROR_BODY_BYTES, signal);
  if (text === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(value) || !isRecord(value.error)) return {};
  const errorStatus = knownProviderErrorStatus(value.error.status);
  const errors = Array.isArray(value.error.errors) ? value.error.errors : [];
  const details = Array.isArray(value.error.details) ? value.error.details : [];
  const reasons = [
    ...errors.slice(0, 1).map((entry) => isRecord(entry) ? knownProviderErrorReason(entry.reason) : undefined),
    ...details.map((entry) => isRecord(entry) ? knownProviderErrorReason(entry.reason) : undefined),
  ].filter((reason): reason is string => reason !== undefined);
  const errorReason = reasons.find((reason) => !GENERIC_GOOGLE_REASONS.test(reason)) ?? reasons[0];
  return {
    ...(errorStatus === undefined ? {} : { errorStatus }),
    ...(errorReason === undefined ? {} : { errorReason }),
  };
}

/** Reads a JSON response with a hard byte ceiling; a provider cannot exhaust memory. */
export async function readJsonCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await readTextCapped(response, maxBytes, signal);
  if (text === null) {
    throw new MetadataProviderError("unavailable", { reason: "bad_response", status: response.status });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MetadataProviderError("unavailable", { reason: "bad_response", status: response.status });
  }
}

const isAbort = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
};

/**
 * A body that is discarded because its declared/actual size exceeds the ceiling is not a
 * read failure. If the cancellation itself is caused by the caller's abort, however, the
 * timeout must win over the size classification.
 */
const cancelQuietly = async (cancel: () => Promise<void>, signal?: AbortSignal): Promise<void> => {
  try {
    await cancel();
  } catch (error) {
    if (signal?.aborted || isAbort(error)) throw providerFailure(error, signal);
  }
};

/**
 * Reads a response body with a hard ceiling. `null` means the body is absent or too large
 * (the caller decides between `bad_response` and HTTP status); a failed/aborted read is
 * thrown as a classified provider failure, preserving the legacy timeout/network codes.
 */
export async function readTextCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await cancelQuietly(() => response.body?.cancel() ?? Promise.resolve(), signal);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await cancelQuietly(() => reader.cancel(), signal);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    // A read failure is not an invalid body: signal aborts map to timeout/legacy timeout,
    // transport failures map to unavailable/network with the Node code when present.
    await reader.cancel().catch(() => undefined);
    throw providerFailure(error, signal);
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringValue = (value: unknown): string | null => typeof value === "string" ? value : null;
