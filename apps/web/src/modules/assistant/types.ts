/**
 * HTTP contract types for the Assistant chat (`/api/chat/*`).
 * Mirrors docs/planner/2026-11-22-tutor-sessions-ask-mode.md.
 * Keep this module free of server imports and runtime logic.
 */

/** Ask answers are ephemeral; Session answers are saved with their history. */
export type ChatMode = "ask" | "session";

/** Per-turn book recommendation request; `on` comes from the explicit button. */
export type RecommendMode = "auto" | "on" | "off";

/** Stored Ask preference: automatic suggestions or none. */
export type RecommendPreference = Exclude<RecommendMode, "on">;

/** Effective limits reported by `GET /api/chat/status` (absent on older servers). */
export type SessionLimits = {
  maxSessions: number;
  count: number;
  maxMessages: number;
};

/** Additive capabilities reported by `GET /api/chat/status`. */
export type ChatFeatures = {
  recommendations?: boolean;
};

/** Whether the operator configured a provider; when false every chat surface stays hidden. */
export type ChatStatus = {
  enabled: boolean;
  model: string | null;
  host: string | null;
  promptVersion: string;
  scopes: { library: boolean; book: boolean };
  /** Present only on servers that support Ask. Absent means Session only. */
  modes?: ChatMode[];
  sessionLimits?: SessionLimits;
  /** Additive feature flags; absent means the server predates them. */
  features?: ChatFeatures;
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

export type RecommendationStatus = "ready" | "none" | "library_off" | "unavailable";
/** `explicit` when the user pressed "Suggest books"; `detected` for the automatic path. */
export type RecommendationIntent = "explicit" | "detected";
export type RecommendationFocus = "recommend" | "learn";

/** One shortlisted book from the user's library; `n` matches `[book:n]` in the answer. */
export type RecommendedBook = {
  n: number;
  bookId: string;
  title: string;
  author: string;
  format: "pdf" | "epub";
  language: string | null;
  hasCover: boolean;
  coverRev: number | null;
  progress: { status: "unread" | "reading" | "finished"; percentage: number };
  matched: string[];
  evidence: Array<{ passageId: number; page: number | null; section: string | null }>;
  source: "passages" | "metadata" | "both";
};

/** Payload of the one `recommendations` SSE event of a turn. */
export type ChatRecommendations = {
  status: RecommendationStatus;
  intent: RecommendationIntent;
  focus: RecommendationFocus;
  books: RecommendedBook[];
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
  /** Client-only: the turn's recommendation payload, attached when the turn reaches `done`. */
  recommendations?: ChatRecommendations;
  /** Client-only: the validated `[book:n]` markers from `done.recommended`. */
  recommended?: number[];
};

/** `GET /api/chat/conversations` item, ordered by `updatedAt` desc. */
export type ConversationSummary = {
  id: string;
  title: string;
  scope: ChatScope;
  updatedAt: number;
  createdAt?: number;
  messageCount?: number;
  persisted?: boolean;
};

/** `GET /api/chat/conversations/:id` */
export type ConversationDetail = {
  id: string;
  title: string;
  scope: ChatScope;
  messages: ChatMessage[];
  createdAt?: number;
  messageCount?: number;
};

/** One imported turn for "Save as session" (`POST /api/chat/conversations`). */
export type ImportedMessage = {
  role: ChatRole;
  content: string;
  citations?: Citation[];
};

/** `POST /api/chat/conversations` body: turns an Ask transcript into a Session. */
export type SaveConversationRequest = {
  scope: ChatScope;
  title?: string;
  messages: ImportedMessage[];
};

/** `PATCH /api/chat/conversations/:id` body. */
export type RenameConversationRequest = { title: string };

/** `POST /api/chat/messages` body; omit `conversationId` to start a conversation. */
export type ChatRequest = {
  conversationId?: string;
  message: string;
  scope: ChatRequestScope;
  /** Only sent when the server advertises `modes`; absent means the legacy Session turn. */
  mode?: ChatMode;
  /** Ask only: whether the turn may search the library. */
  useLibrary?: boolean;
  /** Ask + library scope only: `on` for one explicit request, else the stored preference. */
  recommend?: RecommendMode;
};

/** Failure codes carried by the terminal SSE `error` event. */
export type ChatErrorCode =
  | "llm_unavailable"
  | "llm_timeout"
  | "llm_rejected"
  | "llm_protocol"
  | "llm_empty"
  | "search_failed"
  | "conversation_limit"
  | "aborted";

/** First SSE event of a turn: citations the answer may reference. */
export type ChatSourcesEvent = {
  type: "sources";
  /** `null` in Ask: the turn is not saved. */
  conversationId: string | null;
  retrieval: ChatRetrieval;
  citations: Citation[];
  mode?: ChatMode;
  persisted?: boolean;
  useLibrary?: boolean;
};

/** Zero or more incremental answer chunks. */
export type ChatDeltaEvent = { type: "delta"; text: string };

/** Emitted once, after `sources` and before the deltas, when recommendations ran. */
export type ChatRecommendationsEvent = { type: "recommendations" } & ChatRecommendations;

/** Last SSE event on success. */
export type ChatDoneEvent = {
  type: "done";
  /** `null` in Ask: the turn is not saved. */
  conversationId: string | null;
  messageId: string;
  title: string;
  finishReason: "stop" | "length";
  mode?: ChatMode;
  persisted?: boolean;
  /** `[book:n]` markers the model emitted, in order, only when recommendations were `ready`. */
  recommended?: number[];
};

/** Terminal SSE event that replaces `done`. */
export type ChatErrorEvent = { type: "error"; code: ChatErrorCode; message: string };

export type ChatEvent =
  | ChatSourcesEvent
  | ChatRecommendationsEvent
  | ChatDeltaEvent
  | ChatDoneEvent
  | ChatErrorEvent;
