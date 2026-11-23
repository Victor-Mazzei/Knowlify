/**
 * Pure context helpers for the tutor: card-marker cleanup for derived retrieval anchors,
 * removal of legacy canned turns, token estimation and the deterministic retrieval
 * queries of ADR-5/ADR-6. Stored history is never rewritten here.
 */
import { stripBookMarkers } from "./bookMarkers.js";

/** Legacy turn text persisted by older builds, before the tutor always called the model. */
export const NO_PASSAGES_ANSWER = "I couldn't find passages about this in your library yet.";

/** Retrieval query budget, aligned with `PassageSearch`. */
export const MAX_QUERY_CHARS = 500;

const MAX_ANCHOR_CHARS = 250;
const FOLLOW_UP_MAX_WORDS = 12;
const FOLLOW_UP_MAX_CHARS = 80;

/** Minimal shape shared by persisted messages and prompt messages. */
export interface ContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Conservative estimate; the provider already reports `context_length_exceeded`. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Removes turns answered with the old canned "no passages" reply, pairing the
 * assistant message with the user question right before it. Comparison is exact:
 * a real model answer that happens to mention the phrase is kept.
 */
export function dropCannedPairs(history: readonly ContextMessage[]): ContextMessage[] {
  const kept: ContextMessage[] = [];
  for (const message of history) {
    if (message.role === "assistant" && message.content === NO_PASSAGES_ANSWER) {
      if (kept.at(-1)?.role === "user") kept.pop();
      continue;
    }
    kept.push(message);
  }
  return kept;
}

/**
 * Deterministic retrieval queries (ADR-5). A short follow-up is anchored on the tutor's
 * last question so the answer is searched in the context the user is replying to; any
 * other message is searched as written, with the anchored form as a zero-hit fallback.
 * The message as written is always searched: a follow-up may be short in words but long
 * in characters, so expansion must not spend its budget on the anchor and drop its tail.
 */
export function buildRetrievalQueries(question: string, history: readonly ContextMessage[]): string[] {
  const normalized = question.trim();
  if (!normalized) return [];
  const base = capQuery(normalized);
  if (history.length === 0) return [base];

  const anchor = retrievalAnchor(history);
  const expansion = anchor ? expandQuery(anchor, base) : undefined;
  const expanded = expansion?.query ?? base;
  const followUp = countWords(normalized) <= FOLLOW_UP_MAX_WORDS || normalized.length < FOLLOW_UP_MAX_CHARS;
  if (followUp) {
    if (expanded === base) return [base];
    // A terse reply leans on the anchor, but one long enough to squeeze the anchor is
    // searched as written first; the anchored form then only runs after zero hits.
    return expansion?.anchorComplete ? [expanded, base] : [base, expanded];
  }
  return expanded === base ? [base] : [base, expanded];
}

interface QueryExpansion {
  query: string;
  /** False when the anchor gave up characters so the message could stay whole. */
  anchorComplete: boolean;
}

/**
 * Reserves the budget for the message first and gives the anchor only what is left.
 * Capping the concatenation would silently drop terms at the end of a long follow-up.
 */
function expandQuery(anchor: string, base: string): QueryExpansion {
  const room = MAX_QUERY_CHARS - base.length - 1;
  if (room <= 0) return { query: base, anchorComplete: false };
  const head = anchor.slice(0, room).trimEnd();
  if (!head) return { query: base, anchorComplete: false };
  return { query: `${head} ${base}`, anchorComplete: head.length === anchor.length };
}

function retrievalAnchor(history: readonly ContextMessage[]): string | undefined {
  const assistant = findLast(history, (message) => message.role === "assistant" && message.content.trim() !== "");
  const tutorQuestion = assistant ? lastQuestionSentence(assistant.content) : undefined;
  if (tutorQuestion) return tutorQuestion.slice(0, MAX_ANCHOR_CHARS);

  const user = findLast(history, (message) => message.role === "user" && message.content.trim() !== "");
  if (!user) return undefined;
  const previousQuestion = stripBookMarkers(user.content);
  return previousQuestion ? previousQuestion.slice(0, MAX_ANCHOR_CHARS) : undefined;
}

/**
 * Last interrogative sentence, so an earlier "Great." does not become the anchor.
 * Scans backwards instead of matching `/[^.?!]*\?/g`: on a long answer with no
 * terminator (a code block, a table) the regex retried at every position and cost
 * O(n²) in the request path.
 */
function lastQuestionSentence(text: string): string | undefined {
  const flattened = stripBookMarkers(text).replace(/\s+/g, " ").trim();
  const questionMark = flattened.lastIndexOf("?");
  if (questionMark < 0) return undefined;
  const previous = Math.max(
    flattened.lastIndexOf(".", questionMark - 1),
    flattened.lastIndexOf("?", questionMark - 1),
    flattened.lastIndexOf("!", questionMark - 1),
  );
  const sentence = flattened.slice(previous + 1, questionMark + 1).trim();
  return sentence || undefined;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function capQuery(text: string): string {
  return text.slice(0, MAX_QUERY_CHARS).trim();
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}
