import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { ValidationError } from "../../domain/errors.js";
import { isContentHash, parseContentGroupKey } from "../../domain/library/ContentIdentity.js";
import type { DuplicateContentAnchor } from "../../ports/library-dedup.js";
import type { DuplicateFinder, MergeConfirmation, MergeGroupRequest, MergeRequest } from "../../use-cases/DuplicateFinder.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_GROUPS = 500;
const MAX_CURSOR_CHARS = 1024;
const SIGNATURE_BYTES = 16;
const SECRET = config.secret.value ? Buffer.from(config.secret.value, "utf8") : randomBytes(32);

const parseLimit = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  const limit = Number(value);
  if (limit < 1 || limit > MAX_LIMIT) throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  return limit;
};

const encodeCursor = (anchor: DuplicateContentAnchor): string => {
  const payload = Buffer.from(`${anchor.size}:${anchor.contentHash}`, "utf8");
  const signature = createHmac("sha256", SECRET).update(payload).digest().subarray(0, SIGNATURE_BYTES);
  return Buffer.concat([payload, signature]).toString("base64url");
};

const decodeCursor = (cursor: string): DuplicateContentAnchor => {
  if (cursor.length > MAX_CURSOR_CHARS) throw new ValidationError("cursor is invalid");
  const raw = Buffer.from(cursor, "base64url");
  if (raw.length <= SIGNATURE_BYTES || raw.toString("base64url") !== cursor) {
    throw new ValidationError("cursor is invalid");
  }
  const payload = raw.subarray(0, raw.length - SIGNATURE_BYTES);
  const signature = raw.subarray(raw.length - SIGNATURE_BYTES);
  const expected = createHmac("sha256", SECRET).update(payload).digest().subarray(0, SIGNATURE_BYTES);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new ValidationError("cursor is invalid");
  }
  try {
    return parseContentGroupKey(payload.toString("utf8"));
  } catch {
    throw new ValidationError("cursor is invalid");
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseMergeRequest(body: unknown): MergeRequest {
  if (!isRecord(body)) throw new ValidationError("Invalid merge request");
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    throw new ValidationError("dryRun must be a boolean");
  }
  if (body.groups === undefined && body.confirm === undefined) {
    throw new ValidationError("groups or confirm is required");
  }
  let groups: MergeGroupRequest[] | "all" | undefined;
  if (body.groups !== undefined) {
    const raw = body.groups;
    if (raw === "all") {
      groups = "all";
    } else if (Array.isArray(raw)) {
      if (raw.length === 0) throw new ValidationError("groups cannot be empty");
      if (raw.length > MAX_GROUPS) throw new ValidationError(`at most ${MAX_GROUPS} groups can be merged per request`);
      groups = raw.map((entry) => {
        if (!isRecord(entry) || typeof entry.key !== "string") {
          throw new ValidationError("each group needs a key");
        }
        parseContentGroupKey(entry.key);
        if (entry.canonicalId !== undefined && typeof entry.canonicalId !== "string") {
          throw new ValidationError("canonicalId must be a string");
        }
        return entry.canonicalId === undefined
          ? { key: entry.key }
          : { key: entry.key, canonicalId: entry.canonicalId };
      });
    } else {
      throw new ValidationError('groups must be "all" or an array');
    }
  }
  let confirm: MergeConfirmation[] | undefined;
  if (body.confirm !== undefined) {
    const raw = body.confirm;
    if (!Array.isArray(raw)) throw new ValidationError("confirm must be an array");
    if (raw.length === 0) throw new ValidationError("confirm cannot be empty");
    if (raw.length > MAX_GROUPS) throw new ValidationError(`at most ${MAX_GROUPS} groups can be merged per request`);
    const seen = new Set<string>();
    confirm = raw.map((entry) => {
      if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.fingerprint !== "string") {
        throw new ValidationError("each confirmation needs a key and a fingerprint");
      }
      parseContentGroupKey(entry.key);
      if (!isContentHash(entry.fingerprint)) throw new ValidationError("fingerprint is invalid");
      if (seen.has(entry.key)) throw new ValidationError("confirm keys must be unique");
      seen.add(entry.key);
      return { key: entry.key, fingerprint: entry.fingerprint };
    });
  }
  return { ...(groups === undefined ? {} : { groups }), ...(confirm === undefined ? {} : { confirm }), dryRun: body.dryRun === true };
}

export async function duplicateRoutes(app: FastifyInstance, opts: { duplicates: DuplicateFinder }) {
  const { duplicates } = opts;
  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/duplicates", async (req) => {
    const limit = parseLimit(req.query.limit);
    const anchor = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor);
    const page = duplicates.page(limit, anchor);
    return {
      groups: page.groups,
      nextCursor: page.nextAnchor === null ? null : encodeCursor(page.nextAnchor),
      summary: page.summary,
    };
  });
  app.post("/duplicates/scan", async (_req, reply) => {
    duplicates.trigger();
    return reply.code(202).send(duplicates.status());
  });
  app.post<{ Body: unknown }>("/duplicates/merge", async (req) => duplicates.merge(parseMergeRequest(req.body)));
}
