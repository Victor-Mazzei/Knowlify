import type {
  LlmEndpointProbe,
  LlmModelsResult,
  LlmProbeTarget,
  LlmTestResult,
} from "../../ports/llm-settings.js";
import {
  extractModels,
  probeCode,
  probeCustomHeaders,
  readJson,
  statusCode,
  timeoutSignal,
} from "./probeSupport.js";
import { LLM_API_STYLE_PROFILES } from "../../domain/assistant/LlmApiStyle.js";

function modelsUrl(base: string): string {
  const url = new URL(base);
  let path = url.pathname.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith("/chat/completions")) {
    path = path.slice(0, -"/chat/completions".length);
  }
  url.pathname = `${path}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function chatUrl(base: string): string {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.toLowerCase().endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function headers(target: LlmProbeTarget): Record<string, string> {
  return {
    accept: "application/json",
    ...LLM_API_STYLE_PROFILES.openai.defaultHeaders,
    ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
    ...probeCustomHeaders(target),
  };
}

interface ModelsAttempt {
  result: LlmModelsResult;
  latencyMs: number;
}

/**
 * Read-only OpenAI-compatible probe. `/models` never spends tokens; `testChat` falls
 * back to a one-token chat completion only when `/models` is unsupported and a model
 * name is available. Provider bodies and resolved addresses never reach the caller.
 */
export class OpenAiModelsProbe implements LlmEndpointProbe {
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
      // `/models` is not implemented: prove the chat endpoint with one token, but only
      // when a model is known; otherwise there is nothing to test.
      if (!target.model) return { ok: true, latencyMs: this.elapsed(started) };
      const response = await this.doFetch(chatUrl(target.url), {
        method: "POST",
        redirect: "error",
        signal,
        headers: { ...headers(target), "content-type": "application/json" },
        body: JSON.stringify({
          model: target.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
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
