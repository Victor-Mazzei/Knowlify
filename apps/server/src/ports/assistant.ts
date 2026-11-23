import type { ChatMessage, Conversation } from "../domain/assistant/Conversation.js";
import type { PassageSearchHit } from "./knowledge.js";

export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }
export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens: number;
  temperature: number;
  /**
   * Stable id for this conversation. A custom header value may use
   * `{{conversationId}}`; content never depends on it.
   */
  sessionId?: string;
}
export type LlmEvent = { type: "delta"; text: string } | { type: "done"; finishReason: "stop" | "length" }
export type LlmErrorCode = "unavailable" | "timeout" | "rejected" | "protocol" | "aborted"
/**
 * Fixed diagnosis for a provider failure. It is an allowlist, never provider text:
 * an error body may echo the prompt, book passages, URLs or credentials, so none of
 * it may reach a log line or the SSE stream.
 */
export type LlmProviderDiagnostic =
  | "missing_session"
  | "unsupported_max_tokens"
  | "unsupported_temperature"
  | "model_not_found"
  | "authentication_failed"
  | "permission_denied"
  | "context_length_exceeded"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_request"
  | "unknown";
export interface LlmProviderErrorDetails {
  /** HTTP status returned by the provider, when the failure came from a non-2xx response. */
  providerStatus?: number;
  /** Allowlisted diagnosis; safe to log and expose to the client. */
  providerDetail?: LlmProviderDiagnostic;
}
export class LlmError extends Error {
  readonly providerStatus: number | undefined;
  readonly providerDetail: LlmProviderDiagnostic | undefined;
  constructor(readonly code: LlmErrorCode, message: string, details: LlmProviderErrorDetails = {}) {
    super(message);
    this.providerStatus = details.providerStatus;
    this.providerDetail = details.providerDetail;
  }
}
export interface LlmClient {
  readonly configured: boolean; readonly model: string | null; readonly host: string | null;
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
}
export interface PassageRetriever {
  search(q: { q: string; bookId?: string; limit: number }, options?: { allowShortQuery?: boolean }): Promise<{
    mode: string;
    hits: PassageSearchHit[];
    /** A search read timed out or the worker was discarded; the prompt must say so. */
    unavailable?: boolean;
  }>;
}
/** Retention caps enforced atomically with the turn write. */
export interface ConversationCaps {
  maxConversations: number;
  maxMessagesPerConversation: number;
}

export interface ConversationTurn {
  /** Existing conversation id, or the id of `newConversation` when the turn starts one. */
  conversationId: string;
  /** Row inserted in the same transaction; `null` when the turn continues a conversation. */
  newConversation: Conversation | null;
  user: ChatMessage;
  assistant: ChatMessage;
}

export interface ConversationRepository {
  create(c: Conversation): void; get(id: string): Conversation | undefined;
  messages(id: string): ChatMessage[];
  /**
   * Writes the whole turn in one transaction: creates the conversation when new,
   * evicts the least recently updated conversation beyond `maxConversations`, then
   * inserts the user and assistant messages. The message cap is re-checked inside
   * the transaction and rejects with `ConversationFullError`; any failure rolls
   * back every change of this call (nothing is written and nothing is deleted).
   */
  saveTurn(turn: ConversationTurn, caps: ConversationCaps, now: number): void;
  list(scope: { kind: "library" } | { kind: "book"; bookId: string }, limit: number): Conversation[];
  delete(id: string): boolean; deleteForBook(bookId: string): void; countAll(): number;
  /**
   * Moves book-scoped conversations to the canonical book and rewrites the `bookId` inside
   * stored citations. Returns how many conversations and citation payloads changed.
   */
  reassign(fromBookId: string, toBookId: string): { conversations: number; citations: number };
}
