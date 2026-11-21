import { ValidationError } from "../errors.js";

/** Fixed palette keys; the web maps each key to its own tokens, so no CSS value is stored. */
export const TAG_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export const DEFAULT_TAG_COLOR: TagColor = "gray";

export const TAG_NAME_MAX = 40;
/** Product limits (ADR-5): 200 tags in total and 50 tags on a single book. */
export const TAG_LIMITS = { maxTags: 200, maxPerBook: 50 } as const;
/** `add`/`remove` accept at most 20 tag ids each in one bulk request. */
export const MAX_TAG_IDS_PER_REQUEST = 20;

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
  createdAt: number;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * A tag name is trimmed and has internal whitespace collapsed. Control characters are
 * rejected instead of stripped so two names can never silently become the same one.
 */
export function normalizeTagName(input: unknown): string {
  if (typeof input !== "string") throw new ValidationError("Tag name must be a string");
  const name = input.trim().replace(/\s+/gu, " ");
  if ([...name].length === 0 || [...name].length > TAG_NAME_MAX) {
    throw new ValidationError(`Tag name must have 1 to ${TAG_NAME_MAX} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) throw new ValidationError("Tag name cannot contain control characters");
  return name;
}

/** Case-insensitive identity. NFKC folds compatibility forms; NOCASE alone only covers ASCII. */
export const tagKey = (name: string): string =>
  normalizeTagName(name).normalize("NFKC").toLocaleLowerCase("en");

export function assertTagColor(value: unknown): TagColor {
  if (value === undefined) return DEFAULT_TAG_COLOR;
  if (typeof value !== "string" || !TAG_COLORS.includes(value as TagColor)) {
    throw new ValidationError(`color must be one of: ${TAG_COLORS.join(", ")}`);
  }
  return value as TagColor;
}
