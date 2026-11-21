import { ValidationError } from "../errors.js";

const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** Full-file SHA-256 as stored in `books.content_hash`. */
export const isContentHash = (value: string): boolean => CONTENT_HASH.test(value);

export function assertContentHash(value: string): string {
  if (!isContentHash(value)) throw new ValidationError("Invalid content hash");
  return value;
}

/** Stable key used by the diff API and the UI (`<size>:<sha256>`). */
export const contentGroupKey = (size: number, hash: string): string => `${size}:${hash}`;

export function parseContentGroupKey(key: string): { size: number; contentHash: string } {
  const separator = key.indexOf(":");
  if (separator <= 0) throw new ValidationError("Invalid duplicate group key");
  const sizeText = key.slice(0, separator);
  const contentHash = key.slice(separator + 1);
  const size = Number(sizeText);
  if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || !isContentHash(contentHash)) {
    throw new ValidationError("Invalid duplicate group key");
  }
  return { size, contentHash };
}

/** Inputs that decide which copy survives a manual merge (ADR-7). */
export interface CanonicalCandidate {
  id: string;
  notes: number;
  conversations: number;
  hasProgress: boolean;
  indexed: boolean;
  status: "pending" | "ready" | "error";
  /** Uploads (managed files) win a full tie against external folders. */
  managed: boolean;
  addedAt: number;
}

const userDataWeight = (candidate: CanonicalCandidate): number =>
  candidate.notes + candidate.conversations + (candidate.hasProgress ? 1 : 0);

const compareCandidates = (a: CanonicalCandidate, b: CanonicalCandidate): number =>
  userDataWeight(b) - userDataWeight(a)
  || Number(b.indexed) - Number(a.indexed)
  || Number(b.status === "ready") - Number(a.status === "ready")
  || Number(b.managed) - Number(a.managed)
  || a.addedAt - b.addedAt
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Deterministic winner; the user may override it before confirming a merge. */
export function pickCanonical(candidates: readonly CanonicalCandidate[]): CanonicalCandidate {
  if (candidates.length === 0) throw new ValidationError("A duplicate group needs a book");
  return [...candidates].sort(compareCandidates)[0]!;
}
