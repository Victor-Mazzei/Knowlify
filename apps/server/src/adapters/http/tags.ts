import type { FastifyInstance } from "fastify";
import { ValidationError } from "../../domain/errors.js";
import type { Tags } from "../../use-cases/Tags.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseCreate = (body: unknown): { name: unknown; color?: string } => {
  if (!isRecord(body)) throw new ValidationError("Invalid tag");
  if (body.color !== undefined && typeof body.color !== "string") throw new ValidationError("color must be a string");
  return body.color === undefined ? { name: body.name } : { name: body.name, color: body.color };
};

const parseUpdate = (body: unknown): { name?: string; color?: string } => {
  if (!isRecord(body)) throw new ValidationError("Invalid tag");
  if (body.name !== undefined && typeof body.name !== "string") throw new ValidationError("name must be a string");
  if (body.color !== undefined && typeof body.color !== "string") throw new ValidationError("color must be a string");
  const patch: { name?: string; color?: string } = {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.color === undefined ? {} : { color: body.color }),
  };
  if (patch.name === undefined && patch.color === undefined) {
    throw new ValidationError("At least one of name or color is required");
  }
  return patch;
};

export async function tagRoutes(app: FastifyInstance, opts: { tags: Tags }) {
  const { tags } = opts;
  app.get("/tags", async () => ({ items: tags.list() }));
  app.post("/tags", async (req, reply) => reply.code(201).send(tags.create(parseCreate(req.body))));
  app.patch<{ Params: { id: string } }>("/tags/:id", async (req) => tags.update(req.params.id, parseUpdate(req.body)));
  app.delete<{ Params: { id: string } }>("/tags/:id", async (req, reply) => {
    tags.remove(req.params.id);
    return reply.code(204).send();
  });
}
