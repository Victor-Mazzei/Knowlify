import type { ChatErrorCode, ChatEvent, ChatRetrieval, Citation } from "./types";

type SseMessage = { event: string; data: string };

const ERROR_CODES: readonly ChatErrorCode[] = [
  "llm_unavailable",
  "llm_timeout",
  "llm_rejected",
  "llm_protocol",
  "search_failed",
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

const RETRIEVALS: readonly ChatRetrieval[] = ["hybrid", "semantic", "lexical", "none"];

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
    if (typeof value.conversationId !== "string" || !Array.isArray(value.citations)) return null;
    const citations = value.citations
      .map(parseCitation)
      .filter((citation): citation is Citation => citation !== null);
    const retrieval = RETRIEVALS.find((item) => item === value.retrieval) ?? "none";
    return { type: "sources", conversationId: value.conversationId, retrieval, citations };
  }
  if (value.type === "delta") {
    return typeof value.text === "string" ? { type: "delta", text: value.text } : null;
  }
  if (value.type === "done") {
    if (
      typeof value.conversationId !== "string" ||
      typeof value.messageId !== "string" ||
      typeof value.title !== "string"
    )
      return null;
    const finishReason = value.finishReason === "length" ? "length" : "stop";
    return {
      type: "done",
      conversationId: value.conversationId,
      messageId: value.messageId,
      title: value.title,
      finishReason,
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
