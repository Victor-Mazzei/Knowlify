import type {
  ChatErrorCode,
  ChatEvent,
  ChatMode,
  ChatRecommendations,
  ChatRetrieval,
  Citation,
  RecommendationFocus,
  RecommendationIntent,
  RecommendationStatus,
  RecommendedBook,
} from "./types";

type SseMessage = { event: string; data: string };

const ERROR_CODES: readonly ChatErrorCode[] = [
  "llm_unavailable",
  "llm_timeout",
  "llm_rejected",
  "llm_protocol",
  "llm_empty",
  "search_failed",
  "conversation_limit",
  "aborted",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Incremental Server-Sent Events parser. Feed decoded text as chunks arrive; it handles
 * chunk boundaries, CRLF, comments (heartbeats) and multi-line `data` fields.
 */
export function createSseParser(onMessage: (message: SseMessage) => void) {
  let buffer = "";
  let dataLines: string[] = [];
  let eventName = "";

  const dispatch = () => {
    if (dataLines.length > 0) onMessage({ event: eventName || "message", data: dataLines.join("\n") });
    dataLines = [];
    eventName = "";
  };

  const handleLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        // A chunk may end between "\r" and "\n"; wait for the rest of the break.
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        handleLine(line);
      }
    },
    flush() {
      if (buffer) {
        const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        buffer = "";
        handleLine(line);
      }
      dispatch();
    },
  };
}

function parseCitation(value: unknown): Citation | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.n !== "number" ||
    typeof value.passageId !== "number" ||
    typeof value.bookId !== "string" ||
    typeof value.bookTitle !== "string"
  )
    return null;
  return {
    n: value.n,
    passageId: value.passageId,
    bookId: value.bookId,
    bookTitle: value.bookTitle,
    page: typeof value.page === "number" ? value.page : null,
    section: typeof value.section === "string" ? value.section : null,
  };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const parseEvidence = (value: unknown): RecommendedBook["evidence"] => {
  if (!Array.isArray(value)) return [];
  const evidence: RecommendedBook["evidence"] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.passageId !== "number") continue;
    evidence.push({
      passageId: item.passageId,
      page: typeof item.page === "number" ? item.page : null,
      section: typeof item.section === "string" ? item.section : null,
    });
    if (evidence.length === 2) break;
  }
  return evidence;
};

/** Malformed books are dropped; the rest of the event still renders. */
function parseRecommendedBook(value: unknown): RecommendedBook | null {
  if (!isRecord(value)) return null;
  const progress = value.progress;
  const readingStatus = isRecord(progress)
    ? READING_STATUSES.find((status) => status === progress.status)
    : undefined;
  const format = BOOK_FORMATS.find((item) => item === value.format);
  const source = BOOK_SOURCES.find((item) => item === value.source);
  if (
    typeof value.n !== "number" ||
    !Number.isInteger(value.n) ||
    value.n < 1 ||
    typeof value.bookId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.author !== "string" ||
    !format ||
    !source ||
    !readingStatus ||
    !isRecord(progress) ||
    typeof progress.percentage !== "number" ||
    typeof value.hasCover !== "boolean"
  )
    return null;
  return {
    n: value.n,
    bookId: value.bookId,
    title: value.title,
    author: value.author,
    format,
    language: typeof value.language === "string" ? value.language : null,
    hasCover: value.hasCover,
    coverRev: typeof value.coverRev === "number" ? value.coverRev : null,
    progress: { status: readingStatus, percentage: progress.percentage },
    matched: isStringArray(value.matched) ? value.matched.slice(0, 6) : [],
    evidence: parseEvidence(value.evidence),
    source,
  };
}

function parseRecommendations(value: Record<string, unknown>): ChatRecommendations | null {
  const status = RECOMMENDATION_STATUSES.find((item) => item === value.status);
  const intent = RECOMMENDATION_INTENTS.find((item) => item === value.intent);
  const focus = RECOMMENDATION_FOCUSES.find((item) => item === value.focus);
  if (!status || !intent || !focus) return null;
  const books = Array.isArray(value.books)
    ? value.books
        .map(parseRecommendedBook)
        .filter((book): book is RecommendedBook => book !== null)
        .slice(0, 5)
    : [];
  return { status, intent, focus, books };
}

const parseRecommendedNumbers = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter(
    (item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 1,
  );
  return numbers.length > 0 ? numbers : [];
};

const RETRIEVALS: readonly ChatRetrieval[] = ["hybrid", "semantic", "lexical", "none"];
const MODES: readonly ChatMode[] = ["ask", "session"];
const RECOMMENDATION_STATUSES: readonly RecommendationStatus[] = [
  "ready",
  "none",
  "library_off",
  "unavailable",
];
const RECOMMENDATION_INTENTS: readonly RecommendationIntent[] = ["explicit", "detected"];
const RECOMMENDATION_FOCUSES: readonly RecommendationFocus[] = ["recommend", "learn"];
const READING_STATUSES: readonly RecommendedBook["progress"]["status"][] = [
  "unread",
  "reading",
  "finished",
];
const BOOK_SOURCES: readonly RecommendedBook["source"][] = ["passages", "metadata", "both"];
const BOOK_FORMATS: readonly RecommendedBook["format"][] = ["pdf", "epub"];

const parseMode = (value: unknown): ChatMode | undefined =>
  MODES.find((mode) => mode === value);

/** `null` is valid for Ask; `undefined` means the payload did not carry the field. */
const parseConversationId = (value: unknown): string | null | undefined =>
  value === null || typeof value === "string" ? value : undefined;

/**
 * Validates one `data` payload and narrows it to a `ChatEvent`. Unknown or malformed
 * events return `null` so a newer server can add events without breaking this client.
 */
export function parseChatEvent(data: string): ChatEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type === "sources") {
    const conversationId = parseConversationId(value.conversationId);
    if (conversationId === undefined || !Array.isArray(value.citations)) return null;
    const citations = value.citations
      .map(parseCitation)
      .filter((citation): citation is Citation => citation !== null);
    const retrieval = RETRIEVALS.find((item) => item === value.retrieval) ?? "none";
    const mode = parseMode(value.mode);
    const persisted = typeof value.persisted === "boolean" ? value.persisted : undefined;
    const useLibrary = typeof value.useLibrary === "boolean" ? value.useLibrary : undefined;
    return {
      type: "sources",
      conversationId,
      retrieval,
      citations,
      ...(mode ? { mode } : {}),
      ...(persisted === undefined ? {} : { persisted }),
      ...(useLibrary === undefined ? {} : { useLibrary }),
    };
  }
  if (value.type === "delta") {
    return typeof value.text === "string" ? { type: "delta", text: value.text } : null;
  }
  if (value.type === "recommendations") {
    const recommendations = parseRecommendations(value);
    return recommendations ? { type: "recommendations", ...recommendations } : null;
  }
  if (value.type === "done") {
    const conversationId = parseConversationId(value.conversationId);
    if (
      conversationId === undefined ||
      typeof value.messageId !== "string" ||
      typeof value.title !== "string"
    )
      return null;
    const finishReason = value.finishReason === "length" ? "length" : "stop";
    const mode = parseMode(value.mode);
    const persisted = typeof value.persisted === "boolean" ? value.persisted : undefined;
    const recommended = parseRecommendedNumbers(value.recommended);
    return {
      type: "done",
      conversationId,
      messageId: value.messageId,
      title: value.title,
      finishReason,
      ...(mode ? { mode } : {}),
      ...(persisted === undefined ? {} : { persisted }),
      ...(recommended === undefined ? {} : { recommended }),
    };
  }
  if (value.type === "error") {
    const code = ERROR_CODES.find((item) => item === value.code) ?? "llm_protocol";
    return {
      type: "error",
      code,
      message: typeof value.message === "string" ? value.message : "The answer could not be completed.",
    };
  }
  return null;
}
