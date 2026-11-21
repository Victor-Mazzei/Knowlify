import type { BookMetadata, MetadataCandidate, MetadataPatch } from "../types";
import { isValidIsbn10, isValidIsbn13, normalizeIsbn } from "./isbn";

/** Candidate fields the PATCH endpoint understands (series is not provided externally). */
export type CandidateField =
  | "title"
  | "author"
  | "description"
  | "isbn10"
  | "isbn13"
  | "year"
  | "publisher"
  | "language";

export const CANDIDATE_FIELDS: CandidateField[] = [
  "title",
  "author",
  "description",
  "isbn10",
  "isbn13",
  "year",
  "publisher",
  "language",
];

export const CANDIDATE_LABELS: Record<CandidateField, string> = {
  title: "Title",
  author: "Author",
  description: "Description",
  isbn10: "ISBN-10",
  isbn13: "ISBN-13",
  year: "Year",
  publisher: "Publisher",
  language: "Language",
};

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/** Plain-text candidate value; `null` when the provider did not supply it. */
export function candidateValue(candidate: MetadataCandidate, field: CandidateField): string | null {
  switch (field) {
    case "title":
      return candidate.title || null;
    case "author":
      return candidate.authors.length > 0 ? candidate.authors.join(", ") : null;
    case "description":
      return candidate.description;
    case "isbn10":
      return candidate.isbn10 ? normalizeIsbn(candidate.isbn10) : null;
    case "isbn13":
      return candidate.isbn13 ? normalizeIsbn(candidate.isbn13) : null;
    case "year":
      return candidate.year === null ? null : String(candidate.year);
    case "publisher":
      return candidate.publisher;
    case "language":
      return candidate.language;
  }
}

export function currentValue(metadata: BookMetadata, field: CandidateField): string {
  const value = metadata[field];
  return value === null || value === "" ? "" : String(value);
}

/** Why a candidate value cannot be sent as-is, or `null` when it is valid. */
export function candidateProblem(candidate: MetadataCandidate, field: CandidateField, now = new Date()): string | null {
  const value = candidateValue(candidate, field);
  if (!value) return null;
  if (field === "title" && value.length > 300) return "Title is too long.";
  if (field === "author" && value.length > 200) return "Author is too long.";
  if (field === "description" && value.length > 5000) return "Description is too long.";
  if (field === "publisher" && value.length > 200) return "Publisher is too long.";
  if (field === "isbn10" && !isValidIsbn10(value)) return "ISBN-10 checksum is invalid.";
  if (field === "isbn13" && !isValidIsbn13(value)) return "ISBN-13 checksum is invalid.";
  if (field === "language" && !LANGUAGE.test(value.toLowerCase())) return "Language tag is invalid.";
  if (field === "year") {
    const year = Number(value);
    if (!Number.isInteger(year) || year < 1 || year > Math.min(9999, now.getFullYear() + 1)) return "Year is out of range.";
  }
  return null;
}

/** Fields with a value the dialog can offer as a checkbox. */
export function availableCandidateFields(candidate: MetadataCandidate): CandidateField[] {
  return CANDIDATE_FIELDS.filter((field) => candidateValue(candidate, field) !== null);
}

/** Default selection: every usable field, never the cover (that one is opt-in). */
export function defaultCandidateFields(candidate: MetadataCandidate): Set<CandidateField> {
  return new Set(availableCandidateFields(candidate).filter((field) => candidateProblem(candidate, field) === null));
}

export function candidateKey(candidate: MetadataCandidate): string {
  return `${candidate.source}:${candidate.id}`;
}

/** PATCH body for the selected fields; the provider becomes the override source. */
export function candidatePatch(
  candidate: MetadataCandidate,
  fields: ReadonlySet<CandidateField>,
): MetadataPatch {
  const patch: MetadataPatch = {};
  for (const field of fields) {
    const value = candidateValue(candidate, field);
    if (value === null) continue;
    if (field === "year") patch.year = Number(value);
    else if (field === "language") patch.language = value.toLowerCase();
    else patch[field] = value;
  }
  if (Object.keys(patch).length > 0) patch.source = candidate.source;
  return patch;
}
