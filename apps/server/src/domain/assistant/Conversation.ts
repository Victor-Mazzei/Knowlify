import { ValidationError } from "../errors.js";
import { ConversationScopeMismatchError } from "./errors.js";
import type { Citation } from "./Citation.js";

export type { Citation } from "./Citation.js";

/** A conversation belongs either to the whole library or to one book, never both. */
export type ChatScope = { kind: "library" } | { kind: "book"; bookId: string };

export interface Conversation {
  id: string;
  scope: ChatScope;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[] | null;
  promptVersion: string | null;
  createdAt: number;
}

export const MAX_QUESTION_CHARS = 2_000;
export const MAX_TITLE_CHARS = 80;
export const MAX_EXCERPT_CHARS = 2_000;
export const MAX_SECTION_CHARS = 200;
export const MAX_MESSAGES_PER_CONVERSATION = 100;
export const MAX_CONVERSATIONS = 200;
export const MAX_CONVERSATION_ID_CHARS = 200;

/** Trims the question and enforces the documented size, so every layer sees the same value. */
export function normalizeQuestion(raw: string): string {
  const question = raw.trim();
  if (!question) throw new ValidationError("Message must not be empty");
  if (question.length > MAX_QUESTION_CHARS) {
    throw new ValidationError(`Message must have at most ${MAX_QUESTION_CHARS} characters`);
  }
  return question;
}

export function normalizeExcerpt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const excerpt = raw.trim();
  if (!excerpt) return undefined;
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    throw new ValidationError(`Excerpt must have at most ${MAX_EXCERPT_CHARS} characters`);
  }
  return excerpt;
}

/** The first question names the conversation; later turns keep the original title. */
export function conversationTitle(question: string): string {
  return question.slice(0, MAX_TITLE_CHARS).trim();
}

export function sameScope(a: ChatScope, b: ChatScope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "library" || a.bookId === (b as { bookId: string }).bookId;
}

/** Scope is immutable: a turn cannot move an existing conversation to another book. */
export function assertSameScope(conversation: ChatScope, requested: ChatScope): void {
  if (!sameScope(conversation, requested)) {
    throw new ConversationScopeMismatchError("Conversation belongs to a different scope");
  }
}
