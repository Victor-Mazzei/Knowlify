/**
 * Bounded response-body reader shared by outbound adapters. The ceiling is enforced on
 * both the declared `Content-Length` and the streamed bytes, and an oversized body is
 * cancelled, so a provider can neither exhaust memory nor stall the caller.
 *
 * The error mapping stays with the caller: each adapter has its own classified failure
 * type, and moving the read here must not change the errors those adapters already emit.
 */
export interface CappedBodyOptions {
  signal?: AbortSignal;
  /** Maps a failed read (including an abort) to the caller's classified error. */
  mapError: (error: unknown, signal?: AbortSignal) => Error;
}

const isAbort = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
};

/**
 * A body discarded because its declared/actual size exceeds the ceiling is not a read
 * failure. If the cancellation itself is caused by the caller's abort, however, the
 * timeout must win over the size classification.
 */
const cancelQuietly = async (
  cancel: () => Promise<void>,
  options: CappedBodyOptions,
): Promise<void> => {
  try {
    await cancel();
  } catch (error) {
    if (options.signal?.aborted || isAbort(error)) throw options.mapError(error, options.signal);
  }
};

/**
 * Reads a response body with a hard ceiling. `null` means the body is absent or too
 * large (the caller decides how to classify that); a failed/aborted read is thrown as
 * the caller's classified error.
 */
export async function readTextCapped(
  response: Response,
  maxBytes: number,
  options: CappedBodyOptions,
): Promise<string | null> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await cancelQuietly(() => response.body?.cancel() ?? Promise.resolve(), options);
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
        await cancelQuietly(() => reader.cancel(), options);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw options.mapError(error, options.signal);
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
