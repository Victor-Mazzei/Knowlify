import type { CredentialVerifier } from "../../ports/account.js";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import type { SyncProgress } from "../../use-cases/Progress.js";

interface Progress {
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
}

export async function kosyncRoutes(app: FastifyInstance, opts: { syncProgress: SyncProgress; credentials: CredentialVerifier }) {
  app.addHook("preHandler", async (req, reply) => {
    if (typeof req.headers["x-auth-user"] !== "string" || typeof req.headers["x-auth-key"] !== "string" ||
      !opts.credentials.verifyKosync(req.headers["x-auth-user"], req.headers["x-auth-key"])) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
  });

  app.post("/users/create", async (_req, reply) => reply.code(201).send({ username: config.user }));
  app.get("/users/auth", async () => ({ authorized: "OK" }));

  app.put<{ Body: Progress }>("/syncs/progress", {
    schema: {
      body: {
        type: "object",
        required: ["document", "progress", "percentage", "device", "device_id"],
        properties: {
          document: { type: "string", minLength: 1 },
          progress: { type: "string" },
          percentage: { type: "number", minimum: 0, maximum: 1 },
          device: { type: "string" },
          device_id: { type: "string" },
        },
      },
    },
  }, async (req) => {
    return opts.syncProgress.save(req.body);
  });

  app.get<{ Params: { document: string } }>("/syncs/progress/:document", async (req, reply) => {
    return opts.syncProgress.get(req.params.document)
      ?? reply.code(404).send({ message: "Document not found on server" });
  });
}
