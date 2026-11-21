import {
  PROBE_CONVERSATION_ID,
  renderLlmHeaders,
  sensitiveHeaderValues,
  type LlmHeaderStored,
} from "../../domain/assistant/LlmHeaders.js";
import { GuardedFetchError } from "./GuardedFetch.js";
import type { LlmProbeTarget, ProbeCode } from "../../ports/llm-settings.js";

export const PROBE_TIMEOUT_MS = 10_000;
export const MAX_MODELS_BYTES = 1024 * 1024;
export const MAX_MODELS = 500;
export const MAX_MODEL_ID_CHARS = 200;

export function timeoutSignal(): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The provider did not answer in time", "TimeoutError"));
  }, PROBE_TIMEOUT_MS);
  timer.unref();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export function probeCode(error: unknown): ProbeCode {
  if (error instanceof GuardedFetchError) return error.code;
  if (typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError") {
    return "timeout";
  }
  return "unreachable";
}

/** Reads a bounded JSON body; the raw provider text never leaves the probe. */
export async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MODELS_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new GuardedFetchError("rejected");
  }
  if (!response.body) throw new GuardedFetchError("rejected");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > MAX_MODELS_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GuardedFetchError("rejected");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GuardedFetchError("rejected");
  }
}

/**
 * Extracts `data[].id`; malformed entries are ignored, never echoed. Provider-controlled
 * ids that contain the API key or any custom header value actually sent by the probe are
 * dropped: some proxies echo headers, and secrets must never reach the UI, status or logs.
 * Template values are matched as rendered, so `{{conversationId}}` is already resolved,
 * and short values are filtered too.
 */
export function extractModels(payload: unknown, apiKey: string | null, headers: readonly LlmHeaderStored[]): string[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const sensitive = sensitiveHeaderValues(headers);
  const models = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    if (id.length === 0 || id.length > MAX_MODEL_ID_CHARS || /[\u0000-\u001f\u007f]/.test(id)) continue;
    if (apiKey && id.includes(apiKey)) continue;
    if (sensitive.some((value) => id.includes(value))) continue;
    models.add(id);
    if (models.size >= MAX_MODELS) break;
  }
  return [...models].sort();
}

/** Custom headers for a probe; the conversation variable gets a fixed fictitious value. */
export function probeCustomHeaders(target: LlmProbeTarget): Record<string, string> {
  return renderLlmHeaders(target.headers, { conversationId: PROBE_CONVERSATION_ID });
}

/** Probe results use fixed status codes; callers never see provider bodies. */
export function statusCode(status: number): ProbeCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429 || status >= 500) return "unreachable";
  return "rejected";
}
