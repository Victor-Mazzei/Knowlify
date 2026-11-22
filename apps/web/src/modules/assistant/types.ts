/**
 * HTTP contract types for the Assistant chat (`/api/chat/*`).
 * Mirrors docs/planner/2026-11-06-chat-llm-folder-picker-cleanup.md.
 * Keep this module free of server imports and runtime logic.
 */

/** Whether the operator configured a provider; when false every chat surface stays hidden. */
export type ChatStatus = {
  enabled: boolean;
  model: string | null;
  host: string | null;
  promptVersion: string;
  scopes: { library: boolean; book: boolean };
};

/** Scope of a persisted conversation; it cannot change once the conversation exists. */
export type ChatScope = { kind: "library" } | { kind: "book"; bookId: string };

/** Scope sent with a turn; book scope may carry the excerpt the reader is looking at. */
export type ChatRequestScope =
  | { kind: "library" }
  | {
      kind: "book";
      bookId: string;
      excerpt?: string;
      excerptKind?: "selection" | "visible";
      page?: number;
      section?: string;
    };

/** How passages were retrieved for a turn; `none` means no passage backed the answer. */
export type ChatRetrieval = "hybrid" | "semantic" | "lexical" | "none";

/** `n` is the marker used in the answer text (`[n]`). */
export type Citation = {
  n: number;
  passageId: number;
  bookId: string;
  bookTitle: string;
  page: number | null;
  section: string | null;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  citations: Citation[] | null;
  createdAt: number;
  /** Client-only: a partial answer kept after a failure or Stop; never sent by the server. */
  incomplete?: boolean;
};

/** `GET /api/chat/conversations` item, ordered by `updatedAt` desc. */
export type ConversationSummary = {
  id: string;
  title: string;
  scope: ChatScope;
  updatedAt: number;
};

/** `GET /api/chat/conversations/:id` */
export type ConversationDetail = {
  id: string;
  title: string;
  scope: ChatScope;
  messages: ChatMessage[];
};

/** `POST /api/chat/messages` body; omit `conversationId` to start a conversation. */
export type ChatRequest = {
  conversationId?: string;
  message: string;
  scope: ChatRequestScope;
};

/** Failure codes carried by the terminal SSE `error` event. */
export type ChatErrorCode =
  | "llm_unavailable"
  | "llm_timeout"
  | "llm_rejected"
  | "llm_protocol"
  | "llm_empty"
  | "search_failed"
  | "aborted";

/** First SSE event of a turn: citations the answer may reference. */
export type ChatSourcesEvent = {
  type: "sources";
  conversationId: string;
  retrieval: ChatRetrieval;
  citations: Citation[];
};

/** Zero or more incremental answer chunks. */
export type ChatDeltaEvent = { type: "delta"; text: string };

/** Last SSE event on success. */
export type ChatDoneEvent = {
  type: "done";
  conversationId: string;
  messageId: string;
  title: string;
  finishReason: "stop" | "length";
};

/** Terminal SSE event that replaces `done`. */
export type ChatErrorEvent = { type: "error"; code: ChatErrorCode; message: string };

export type ChatEvent = ChatSourcesEvent | ChatDeltaEvent | ChatDoneEvent | ChatErrorEvent;
