import { ValidationError } from "../errors.js";
import { ConversationScopeMismatchError } from "./errors.js";
import { stripBookMarkers } from "./bookMarkers.js";
import type { Citation } from "./Citation.js";

export type { Citation } from "./Citation.js";

/** A conversation belongs either to the whole library or to one book, never both. */
export type ChatScope = { kind: "library" } | { kind: "book"; bookId: string };

/** Ask turns are ephemeral; Session turns are persisted conversations. */
export type ChatMode = "ask" | "session";
export const CHAT_MODES: readonly ChatMode[] = ["ask", "session"];

export interface Conversation {
  id: string;
  scope: ChatScope;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Read model only: filled by list queries, never persisted on the entity. */
  messageCount?: number;
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
export const DEFAULT_MAX_CONVERSATIONS = 200;
export const MIN_MAX_CONVERSATIONS = 20;
export const MAX_MAX_CONVERSATIONS = 5_000;
export const MAX_CONVERSATION_ID_CHARS = 200;
/** Import ("Save as session") bounds; messages must alternate user/assistant. */
export const MAX_IMPORTED_MESSAGES = 20;
export const MAX_IMPORTED_USER_CHARS = 2_000;
export const MAX_IMPORTED_ASSISTANT_CHARS = 8_000;
export const MAX_IMPORTED_CITATIONS = 6;

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

const TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Rename title: trimmed, 1–80 characters, no control characters other than a space. */
export function normalizeTitle(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("The title must be a string");
  const title = raw.trim();
  if (!title) throw new ValidationError("The title must not be empty");
  if (title.length > MAX_TITLE_CHARS) {
    throw new ValidationError(`The title must have at most ${MAX_TITLE_CHARS} characters`);
  }
  if (TITLE_CONTROL_CHARS.test(title)) {
    throw new ValidationError("The title contains unsupported control characters");
  }
  return title;
}

/**
 * Effective session limit. The message lists the range and never echoes the rejected
 * value: it may be a mistyped secret or user text.
 */
export function normalizeMaxConversations(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < MIN_MAX_CONVERSATIONS
    || value > MAX_MAX_CONVERSATIONS
  ) {
    throw new ValidationError(
      `maxConversations must be an integer between ${MIN_MAX_CONVERSATIONS} and ${MAX_MAX_CONVERSATIONS}`,
    );
  }
  return value;
}

/** One validated message of an imported Ask transcript. */
export interface ImportedChatMessage {
  role: "user" | "assistant";
  content: string;
  citations: Citation[] | null;
}

/**
 * Strict validation for "Save as session": alternating user/assistant turns starting
 * with the user and ending with the assistant. Citation titles are re-derived from the
 * library; citations whose book no longer exists are dropped instead of failing the
 * whole import (the transcript itself stays valid).
 *
 * The text is user data: a question is stored exactly as typed, and an answer keeps its
 * text, indentation and numeric `[n]` markers. Only the assistant's `[book:n]` card
 * markers are removed, because cards are not persisted and would render as dead chips.
 */
export function normalizeImportedMessages(
  input: unknown,
  bookTitleFor: (bookId: string) => string | undefined,
): ImportedChatMessage[] {
  if (!Array.isArray(input)) throw new ValidationError("messages must be an array");
  if (input.length < 2 || input.length > MAX_IMPORTED_MESSAGES || input.length % 2 !== 0) {
    throw new ValidationError(
      `messages must contain an even number of turns between 2 and ${MAX_IMPORTED_MESSAGES}, starting with the user`,
    );
  }
  return input.map((entry, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ValidationError(`Message ${index + 1} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "role" && key !== "content" && key !== "citations") {
        throw new ValidationError(`Message ${index + 1} has an unknown field`);
      }
    }
    if (record.role !== role) {
      throw new ValidationError(`Message ${index + 1} must be a ${role} message`);
    }
    if (typeof record.content !== "string") {
      throw new ValidationError(`Message ${index + 1} content must be a string`);
    }
    const raw = record.content;
    if (!raw.trim()) throw new ValidationError(`Message ${index + 1} content must not be empty`);
    const maxChars = role === "user" ? MAX_IMPORTED_USER_CHARS : MAX_IMPORTED_ASSISTANT_CHARS;
    if (raw.trim().length > maxChars) {
      throw new ValidationError(`Message ${index + 1} must have at most ${maxChars} characters`);
    }
    const citations = normalizeImportedCitations(record.citations, role, index, bookTitleFor);
    if (role === "user") {
      // A question is user text: never rewrite its spaces, indentation or markers. A
      // question carries no citations, so `[1]` and `[book:1]` are ordinary characters.
      return { role, content: raw, citations };
    }
    // An answer keeps its text and indentation too; only card markers are removed.
    const cleaned = stripBookMarkers(raw);
    if (!cleaned.trim()) {
      throw new ValidationError(`Message ${index + 1} has no text after removing book markers`);
    }
    return { role, content: cleaned, citations };
  });
}

function normalizeImportedCitations(
  input: unknown,
  role: "user" | "assistant",
  messageIndex: number,
  bookTitleFor: (bookId: string) => string | undefined,
): Citation[] | null {
  if (input === undefined || input === null) return null;
  if (role !== "assistant") {
    throw new ValidationError(`Message ${messageIndex + 1} cannot carry citations`);
  }
  if (!Array.isArray(input)) {
    throw new ValidationError(`Message ${messageIndex + 1} citations must be an array`);
  }
  if (input.length > MAX_IMPORTED_CITATIONS) {
    throw new ValidationError(`Message ${messageIndex + 1} has too many citations`);
  }
  const citations: Citation[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ValidationError(`Message ${messageIndex + 1} has an invalid citation`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!["n", "passageId", "bookId", "bookTitle", "page", "section"].includes(key)) {
        throw new ValidationError(`Message ${messageIndex + 1} has an invalid citation`);
      }
    }
    const n = record.n;
    const passageId = record.passageId;
    const bookId = record.bookId;
    if (
      typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 999
      || typeof passageId !== "number" || !Number.isInteger(passageId) || passageId < 1
      || typeof bookId !== "string" || !bookId || bookId.length > MAX_CONVERSATION_ID_CHARS
    ) {
      throw new ValidationError(`Message ${messageIndex + 1} has an invalid citation`);
    }
    const page = normalizeCitationPage(record.page, messageIndex);
    const section = normalizeCitationSection(record.section, messageIndex);
    const bookTitle = bookTitleFor(bookId);
    if (!bookTitle) continue;
    citations.push({ n, passageId, bookId, bookTitle, page, section });
  }
  return citations.length > 0 ? citations : null;
}

function normalizeCitationPage(value: unknown, messageIndex: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new ValidationError(`Message ${messageIndex + 1} has an invalid citation`);
}

function normalizeCitationSection(value: unknown, messageIndex: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length <= MAX_SECTION_CHARS) return value;
  throw new ValidationError(`Message ${messageIndex + 1} has an invalid citation`);
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
