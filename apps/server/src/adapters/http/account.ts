import type { FastifyInstance } from "fastify";
import { AccountError } from "../../domain/account/Password.js";
import type { Account } from "../../use-cases/Account.js";

export async function accountRoutes(app: FastifyInstance, opts: { account: Account }) {
  app.get("/account", async () => opts.account.get());
  app.put<{ Body: { current: string; next: string } }>("/account/password", {
    bodyLimit: 4096,
    preValidation: async (req) => {
      const body: unknown = req.body;
      if (!body || typeof body !== "object" || !("current" in body) || !("next" in body) ||
        typeof body.current !== "string" || typeof body.next !== "string") {
        throw new AccountError("Current and next passwords must be strings", 400);
      }
    },
    schema: { body: {
      type: "object", required: ["current", "next"], additionalProperties: false,
      properties: { current: { type: "string", maxLength: 1000 }, next: { type: "string", maxLength: 201 } },
    } },
  }, async (req, reply) => {
    opts.account.change(req.body.current, req.body.next, req.ip);
    return reply.code(204).send();
  });
}
