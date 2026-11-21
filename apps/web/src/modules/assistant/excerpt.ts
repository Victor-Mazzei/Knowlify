import type { ChatRequestScope } from "./types";

const MAX_EXCERPT_CHARS = 2000;
const MAX_SECTION_CHARS = 200;

/** Text the reader sends as context for a question. `visible` is the page currently on screen. */
export type ChatExcerpt = {
  text: string;
  kind: "selection" | "visible";
  page?: number;
  section?: string;
};

export function clipExcerpt(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_EXCERPT_CHARS) return clean;
  return `${clean.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
}

const clippedSection = (section?: string) =>
  section ? section.replace(/\s+/g, " ").trim().slice(0, MAX_SECTION_CHARS) : "";

/** Adds the optional excerpt fields only to book-scoped requests with real text. */
export function withExcerpt(scope: ChatRequestScope, excerpt?: ChatExcerpt): ChatRequestScope {
  if (scope.kind !== "book" || !excerpt) return scope;
  const text = clipExcerpt(excerpt.text);
  if (!text) return scope;
  const section = clippedSection(excerpt.section);
  return {
    ...scope,
    excerpt: text,
    excerptKind: excerpt.kind,
    ...(excerpt.page ? { page: excerpt.page } : {}),
    ...(section ? { section } : {}),
  };
}
