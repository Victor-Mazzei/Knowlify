/** The operator did not configure a provider, so every chat surface stays hidden. */
export class ChatDisabledError extends Error {
  readonly code = "chat_disabled";

  constructor(message = "Chat is not configured") {
    super(message);
  }
}

/** A conversation reached the per-conversation message cap. */
export class ConversationFullError extends Error {
  readonly code = "conversation_full";

  constructor(message = "This conversation is full; start a new one") {
    super(message);
  }
}

/** `mode`/`useLibrary`/`conversationId` form an unsupported combination. */
export class InvalidModeError extends Error {
  readonly code = "invalid_mode";

  constructor(message = "Invalid chat mode for this request") {
    super(message);
  }
}

/** The user asked for recommendations while "Use my library" is off. */
export class LibraryRequiredError extends Error {
  readonly code = "library_required";

  constructor(message = "Book recommendations need Use my library") {
    super(message);
  }
}

/** The server reached the configured number of saved sessions; nothing is deleted. */
export class ConversationLimitError extends Error {
  readonly code = "conversation_limit";

  constructor(
    readonly limit: number,
    readonly count: number,
    message = `You have ${count} sessions; the limit is ${limit}. Delete a session or raise the limit to start a new one.`,
  ) {
    super(message);
  }
}

/** A continued conversation cannot change its scope (library vs. book). */
export class ConversationScopeMismatchError extends Error {}

/** Library scope needs the index; book scope can still answer from the reader excerpt. */
export class LibraryChatUnavailableError extends Error {}

/** Per-minute request cap or too many concurrent streams. */
export class ChatRateLimitedError extends Error {
  readonly code = "rate_limited";

  constructor(message: string, readonly retryAfterSec: number) {
    super(message);
  }
}
