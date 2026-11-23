import type { FastifyError, FastifyInstance } from "fastify";
import { ChatLimitsError, type ChatLimitsSettings } from "../../use-cases/ChatLimitsSettings.js";

const BODY_LIMIT = 4 * 1024;

/**
 * Session limit settings (ADR-13). Validation lives in the use case so every rejected
 * value answers the same stable `invalid_value` code and never echoes the value.
 */
export async function settingsChatRoutes(
  app: FastifyInstance,
  opts: { chatLimitsSettings: ChatLimitsSettings },
) {
  const { chatLimitsSettings } = opts;

  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof ChatLimitsError) {
      if (error.retryAfterSec !== undefined) reply.header("Retry-After", String(error.retryAfterSec));
      return reply.code(error.status).send({ message: error.message, code: error.code });
    }
    if (error.statusCode === 413) return reply.code(413).send({ message: "Request body is too large" });
    return reply.send(error);
  });

  app.get("/settings/chat", async () => chatLimitsSettings.get());

  app.put<{ Body: unknown }>(
    "/settings/chat",
    { bodyLimit: BODY_LIMIT },
    async (request) => chatLimitsSettings.update(request.body),
  );
}
