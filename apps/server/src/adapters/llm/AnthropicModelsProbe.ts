import type {
  LlmEndpointProbe,
  LlmModelsResult,
  LlmProbeTarget,
  LlmTestResult,
} from "../../ports/llm-settings.js";
import { LLM_API_STYLE_PROFILES } from "../../domain/assistant/LlmApiStyle.js";
import { DEFAULT_ANTHROPIC_VERSION } from "../../domain/assistant/LlmApiStyle.js";
import {
  extractModels,
  probeCode,
  probeCustomHeaders,
  readJson,
  statusCode,
  timeoutSignal,
} from "./probeSupport.js";

function modelsUrl(base: string): string {
  const url = new URL(base);
  let path = url.pathname.replace(/\/+$/, "");
  const lower = path.toLowerCase();
  if (lower.endsWith("/v1/messages")) path = path.slice(0, -"/v1/messages".length);
  if (!path.toLowerCase().endsWith("/v1")) path = `${path}/v1`;
  url.pathname = `${path}/models`;
  url.search = "limit=1000";
  url.hash = "";
  return url.toString();
}

function messagesUrl(base: string): string {
  const url = new URL(base);
  let path = url.pathname.replace(/\/+$/, "");
  const lower = path.toLowerCase();
  if (!lower.endsWith("/v1/messages")) {
    path = lower.endsWith("/v1") ? `${path}/messages` : `${path}/v1/messages`;
  }
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function headers(target: LlmProbeTarget): Record<string, string> {
  return {
    accept: "application/json",
    ...LLM_API_STYLE_PROFILES.anthropic.defaultHeaders,
    ...(target.apiKey ? { "x-api-key": target.apiKey } : {}),
    ...probeCustomHeaders(target),
  };
}

interface ModelsAttempt {
  result: LlmModelsResult;
  latencyMs: number;
}

/**
 * Anthropic Messages API probe. `/v1/models` is read-only; when a gateway does not
 * implement it and a model is known, `testChat` proves the Messages endpoint with one
 * token. Provider bodies and resolved addresses never reach the caller.
 */
export class AnthropicModelsProbe implements LlmEndpointProbe {
  constructor(
    private readonly doFetch: typeof globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async listModels(target: LlmProbeTarget): Promise<LlmModelsResult> {
    const { signal, cancel } = timeoutSignal();
    try {
      return (await this.models(target, signal)).result;
    } finally {
      cancel();
    }
  }

  async testChat(target: LlmProbeTarget): Promise<LlmTestResult> {
    const started = this.now();
    const { signal, cancel } = timeoutSignal();
    try {
      const models = await this.models(target, signal);
      const failed = models.result.code;
      if (!models.result.supported && failed !== undefined && failed !== "not_found") {
        return { ok: false, latencyMs: models.latencyMs, code: failed };
      }
      if (models.result.supported) {
        if (target.model && !models.result.models.includes(target.model)) {
          return { ok: true, latencyMs: this.elapsed(started), modelFound: false };
        }
        return {
          ok: true,
          latencyMs: this.elapsed(started),
          ...(target.model ? { modelFound: true } : {}),
        };
      }
      // No models endpoint and no model name: there is nothing to test.
      if (!target.model) return { ok: true, latencyMs: this.elapsed(started) };
      const response = await this.doFetch(messagesUrl(target.url), {
        method: "POST",
        redirect: "error",
        signal,
        headers: { ...headers(target), "content-type": "application/json" },
        body: JSON.stringify({
          model: target.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
        }),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) {
        return { ok: true, latencyMs: this.elapsed(started), modelFound: true };
      }
      return {
        ok: false,
        latencyMs: this.elapsed(started),
        code: statusCode(response.status),
      };
    } catch (error) {
      return { ok: false, latencyMs: this.elapsed(started), code: probeCode(error) };
    } finally {
      cancel();
    }
  }

  private async models(target: LlmProbeTarget, signal: AbortSignal): Promise<ModelsAttempt> {
    const started = this.now();
    try {
      const response = await this.doFetch(modelsUrl(target.url), {
        method: "GET",
        redirect: "error",
        signal,
        headers: headers(target),
      });
      const latencyMs = this.elapsed(started);
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        return { result: { supported: false, models: [], code: "unauthorized" }, latencyMs };
      }
      if ([404, 405, 501].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        return { result: { supported: false, models: [] }, latencyMs };
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        return { result: { supported: false, models: [], code: "rejected" }, latencyMs };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return {
          result: {
            supported: false,
            models: [],
            code: response.status === 429 || response.status >= 500 ? "unreachable" : "rejected",
          },
          latencyMs,
        };
      }
      const models = extractModels(await readJson(response), target.apiKey, target.headers);
      if (!models) return { result: { supported: false, models: [], code: "rejected" }, latencyMs };
      return { result: { supported: true, models }, latencyMs };
    } catch (error) {
      return { result: { supported: false, models: [], code: probeCode(error) }, latencyMs: this.elapsed(started) };
    }
  }

  private elapsed(started: number): number {
    return Math.max(0, Math.round(this.now() - started));
  }
}
