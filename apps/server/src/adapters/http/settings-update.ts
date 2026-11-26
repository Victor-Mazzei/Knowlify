import type { FastifyError, FastifyInstance } from "fastify";
import { UpdateError } from "../../domain/update/UpdateError.js";
import type { UpdateNotice } from "../../use-cases/UpdateNotice.js";

const BODY_LIMIT = 4 * 1024;

/**
 * HTTP boundary for the update-check toggle. The route delegates validation to the use
 * case so a bad body always answers the same stable `invalid_body` code; a locked server
 * answers `403 update_locked` before reading the body.
 */
export async function settingsUpdateRoutes(
  app: FastifyInstance,
  opts: { updateNotice: UpdateNotice },
): Promise<void> {
  const { updateNotice } = opts;

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof UpdateError) {
      if (error.retryAfterSec !== undefined) reply.header("Retry-After", String(error.retryAfterSec));
      return reply.code(error.status).send({ message: error.message, code: error.code });
    }
    if (error.statusCode === 413) return reply.code(413).send({ message: "Request body is too large" });
    return reply.send(error);
  });

  app.get("/settings/update", async () => updateNotice.settings());

  app.put<{ Body: unknown }>(
    "/settings/update",
    { bodyLimit: BODY_LIMIT },
    async (request) => updateNotice.updateSettings(request.body),
  );
}
