import type { FastifyError, FastifyInstance } from "fastify";
import { MetadataSettingsError } from "../../domain/library/MetadataSettings.js";
import type { MetadataSettings } from "../../use-cases/MetadataSettings.js";

const BODY_LIMIT = 4 * 1024;

const putSchema = {
  type: "object",
  minProperties: 1,
  // `propertyNames` (not `additionalProperties`) so Fastify's AJV default
  // `removeAdditional` cannot silently drop a typo. Values are validated by the use
  // case: Fastify coerces types, and a numeric key must not become a string.
  propertyNames: { enum: ["lookupEnabled", "googleBooksKey"] },
} as const;

/** Fastify/Ajv failures have no stable domain code; expose the offending field instead. */
function validationField(error: FastifyError): string {
  const first = error.validation?.[0] as
    | { params?: Record<string, unknown>; propertyName?: unknown; instancePath?: unknown }
    | undefined;
  if (!first) return "body";
  const property = first.params?.additionalProperty ?? first.params?.propertyName ?? first.propertyName;
  if (typeof property === "string" && property.length > 0) return property;
  const path = typeof first.instancePath === "string" ? first.instancePath.replace(/^\//, "") : "";
  return path.length > 0 ? path : "body";
}

/**
 * HTTP boundary for `/api/settings/metadata`. The key is accepted only in the JSON body
 * and never echoed in a response or error; every failure has a stable code.
 */
export async function settingsMetadataRoutes(
  app: FastifyInstance,
  opts: { metadataSettings: MetadataSettings },
) {
  const { metadataSettings } = opts;

  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error.validation) {
      return reply.code(400).send({
        message: error.message,
        code: "invalid_settings",
        field: validationField(error),
      });
    }
    if (error instanceof MetadataSettingsError) {
      if (error.retryAfterSec !== undefined) reply.header("Retry-After", String(error.retryAfterSec));
      return reply.code(error.status).send({
        message: error.message,
        code: error.code,
        ...(error.field === undefined ? {} : { field: error.field }),
      });
    }
    if (error.statusCode === 413) {
      return reply.code(413).send({ message: "Request body is too large", code: "invalid_settings", field: "body" });
    }
    return reply.send(error);
  });

  app.get("/settings/metadata", async () => metadataSettings.get());

  app.put<{ Body: unknown }>(
    "/settings/metadata",
    { schema: { body: putSchema }, bodyLimit: BODY_LIMIT },
    async (request) => metadataSettings.update(request.body),
  );
}
