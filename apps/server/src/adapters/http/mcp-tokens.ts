import type { FastifyInstance } from "fastify";
import { ValidationError } from "../../domain/errors.js";
import type { McpAccess } from "../../use-cases/McpAccess.js";

export interface McpTokenRoutesOptions {
  mcpAccess: McpAccess;
  enabled: boolean;
  path: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Closed request shape, like the chat settings routes: unknown fields are a 400. */
const parseCreate = (body: unknown): { name: unknown; scope: unknown } => {
  if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
  const properties = Object.keys(body);
  if (properties.some((key) => key !== "name" && key !== "scope")) {
    throw new ValidationError("Request body accepts only name and scope");
  }
  return { name: body.name, scope: body.scope };
};

/**
 * Token management, authenticated by the existing Basic guard on /api. The clear token
 * appears only in the 201 response; every later read returns the visible prefix.
 */
export async function mcpTokenRoutes(app: FastifyInstance, opts: McpTokenRoutesOptions): Promise<void> {
  const { mcpAccess, enabled, path } = opts;

  app.get("/mcp/tokens", async (_req, reply) => {
    reply.header("Vary", "Authorization").header("Cache-Control", "no-store");
    return { enabled, path, items: mcpAccess.list() };
  });

  app.post("/mcp/tokens", async (req, reply) => {
    if (!enabled) return reply.code(404).send({ message: "MCP is disabled", code: "mcp_disabled" });
    const created = mcpAccess.create(parseCreate(req.body));
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send({ ...created.view, token: created.token });
  });

  // Revocation stays available while the endpoint is disabled: it is the safe direction.
  app.delete<{ Params: { id: string } }>("/mcp/tokens/:id", async (req, reply) => {
    mcpAccess.revoke(req.params.id);
    return reply.code(204).send();
  });
}
