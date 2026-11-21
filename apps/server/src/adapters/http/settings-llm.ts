import type { FastifyError, FastifyInstance } from "fastify";
import { LlmSettingsError, MAX_LLM_MODEL_CHARS, MAX_LLM_URL_CHARS } from "../../domain/assistant/LlmConfig.js";
import { TutorPromptError } from "../../domain/assistant/tutorPrompt.js";
import type { LlmProbeDraft, LlmSettings, LlmUpdateInput } from "../../use-cases/LlmSettings.js";
import type { TutorPromptSettings } from "../../use-cases/TutorPromptSettings.js";

const BODY_LIMIT = 16 * 1024;
const PROMPT_BODY_LIMIT = 20 * 1024;

const apiKeySchema = { type: "string", minLength: 1, maxLength: 512 } as const;
const modelSchema = { type: "string", minLength: 1, maxLength: MAX_LLM_MODEL_CHARS } as const;
const apiStyleSchema = { type: "string", enum: ["openai", "anthropic"] } as const;
const headerSchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64 },
    // Omitted means "keep the saved value"; the domain enforces the origin rule.
    value: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;
const headersSchema = { type: "array", maxItems: 8, items: headerSchema } as const;

const putSchema = {
  type: "object",
  required: ["url"],
  propertyNames: { enum: ["url", "model", "apiKey", "maxTokens", "timeoutSec", "ratePerMin", "apiStyle", "headers"] },
  properties: {
    url: { type: "string", minLength: 1, maxLength: MAX_LLM_URL_CHARS },
    model: { anyOf: [modelSchema, { type: "null" }] },
    apiKey: apiKeySchema,
    maxTokens: { type: "integer", minimum: 1, maximum: 32_768 },
    timeoutSec: { type: "integer", minimum: 5, maximum: 600 },
    ratePerMin: { type: "integer", minimum: 1, maximum: 120 },
    apiStyle: apiStyleSchema,
    headers: headersSchema,
  },
} as const;

const modelsSchema = {
  type: "object",
  propertyNames: { enum: ["url", "apiKey", "apiStyle", "headers"] },
  properties: {
    url: { type: "string", minLength: 1, maxLength: MAX_LLM_URL_CHARS },
    apiKey: apiKeySchema,
    apiStyle: apiStyleSchema,
    headers: headersSchema,
  },
} as const;

const testSchema = {
  type: "object",
  propertyNames: { enum: ["url", "apiKey", "model", "apiStyle", "headers"] },
  properties: {
    url: { type: "string", minLength: 1, maxLength: MAX_LLM_URL_CHARS },
    apiKey: apiKeySchema,
    model: modelSchema,
    apiStyle: apiStyleSchema,
    headers: headersSchema,
  },
} as const;

/**
 * HTTP boundary for the Assistant settings contract. The key is accepted only in the
 * body (never a query string) and is never echoed in any response or error.
 */
export async function settingsLlmRoutes(
  app: FastifyInstance,
  opts: { llmSettings: LlmSettings; tutorPromptSettings: TutorPromptSettings },
) {
  const { llmSettings, tutorPromptSettings } = opts;

  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error.validation) return reply.code(400).send({ message: error.message });
    if (error instanceof LlmSettingsError) {
      if (error.retryAfterSec !== undefined) reply.header("Retry-After", String(error.retryAfterSec));
      return reply.code(error.status).send({
        message: error.message,
        code: error.code,
        ...(error.field !== undefined ? { field: error.field } : {}),
      });
    }
    if (error instanceof TutorPromptError) {
      if (error.retryAfterSec !== undefined) reply.header("Retry-After", String(error.retryAfterSec));
      return reply.code(error.status).send({ message: error.message, code: error.code });
    }
    if (error.statusCode === 413) return reply.code(413).send({ message: "Request body is too large" });
    return reply.send(error);
  });

  app.get("/settings/llm", async () => ({ ...llmSettings.get(), prompt: tutorPromptSettings.get() }));

  app.put<{ Body: unknown }>(
    "/settings/llm/prompt",
    { bodyLimit: PROMPT_BODY_LIMIT },
    async (request) => tutorPromptSettings.update(request.body),
  );

  app.put<{ Body: LlmUpdateInput }>(
    "/settings/llm",
    { schema: { body: putSchema }, bodyLimit: BODY_LIMIT },
    async (request) => llmSettings.update(request.body),
  );

  app.delete("/settings/llm/key", async (_request, reply) => {
    llmSettings.clearKey();
    return reply.code(204).send();
  });

  app.delete("/settings/llm", async (_request, reply) => {
    llmSettings.reset();
    return reply.code(204).send();
  });

  app.post<{ Body: LlmProbeDraft }>(
    "/settings/llm/models",
    { schema: { body: modelsSchema }, bodyLimit: BODY_LIMIT },
    async (request) => llmSettings.listModels(request.body ?? {}),
  );

  app.post<{ Body: LlmProbeDraft }>(
    "/settings/llm/test",
    { schema: { body: testSchema }, bodyLimit: BODY_LIMIT },
    async (request) => llmSettings.test(request.body ?? {}),
  );
}
