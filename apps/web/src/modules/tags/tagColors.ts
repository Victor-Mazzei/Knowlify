import type { TagColor } from "../../types";

/** Fixed palette: the keys travel in the API, the CSS tokens own the values. */
export const TAG_COLORS: readonly TagColor[] = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
];

export const TAG_COLOR_LABELS: Record<TagColor, string> = {
  gray: "Gray",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
};

export const DEFAULT_TAG_COLOR: TagColor = "gray";
export const TAG_NAME_MAX = 40;

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === "string" && (TAG_COLORS as readonly string[]).includes(value);
}

/** Mirrors the server rule: trimmed, collapsed spaces, 1–40 visible characters. */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function isValidTagName(name: string): boolean {
  const normalized = normalizeTagName(name);
  return normalized.length > 0 && normalized.length <= TAG_NAME_MAX && !/[\u0000-\u001f\u007f]/.test(normalized);
}

export const tagColorClass = (color: TagColor) => `tag-color-${color}`;
