import { GuardedFetchError } from "../llm/GuardedFetch.js";
import type { MetadataLookupErrorCode, MetadataLookupFailure } from "../../ports/library-metadata.js";

/** An adapter failure with a stable code; the use case turns it into a partial `errors` entry. */
export class MetadataProviderError extends Error implements MetadataLookupFailure {
  constructor(readonly code: MetadataLookupErrorCode) {
    super(`Metadata provider failed (${code})`);
    this.name = "MetadataProviderError";
  }
}

const isFailure = (value: unknown): value is MetadataLookupFailure =>
  typeof value === "object" && value !== null && "code" in value
  && (value as { code?: unknown }).code !== undefined
  && ["rate_limited", "timeout", "unavailable"].includes((value as { code: string }).code);

/** Maps transport and abort failures without ever exposing an address or provider body. */
export function providerFailure(error: unknown, signal?: AbortSignal): MetadataProviderError {
  if (error instanceof MetadataProviderError) return error;
  if (isFailure(error)) return new MetadataProviderError(error.code);
  if (error instanceof GuardedFetchError) {
    return new MetadataProviderError(error.code === "timeout" ? "timeout" : "unavailable");
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (signal?.aborted || name === "AbortError" || name === "TimeoutError") {
    return new MetadataProviderError("timeout");
  }
  return new MetadataProviderError("unavailable");
}

/** HTTP status to a provider failure: quota is its own state, everything else failed. */
export function statusFailure(status: number): MetadataProviderError {
  if (status === 429 || status === 503) return new MetadataProviderError("rate_limited");
  return new MetadataProviderError("unavailable");
}

/** Reads a JSON response with a hard byte ceiling; a provider cannot exhaust memory. */
export async function readJsonCapped(response: Response, maxBytes: number): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw new MetadataProviderError("unavailable");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MetadataProviderError("unavailable");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MetadataProviderError("unavailable");
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringValue = (value: unknown): string | null => typeof value === "string" ? value : null;
