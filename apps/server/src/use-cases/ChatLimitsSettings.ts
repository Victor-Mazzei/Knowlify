import {
  DEFAULT_MAX_CONVERSATIONS,
  MAX_MAX_CONVERSATIONS,
  MIN_MAX_CONVERSATIONS,
  normalizeMaxConversations,
} from "../domain/assistant/Conversation.js";
import { ValidationError } from "../domain/errors.js";
import type { ChatLimitsStore } from "../ports/llm-settings.js";
import type { Clock, Logger } from "../ports/index.js";

const ADMIN_RATE_PER_MIN = 20;
const RATE_WINDOW_MS = 60_000;

export type ChatLimitsSource = "db" | "env" | "default";
export type ChatLimitsErrorCode = "invalid_value" | "llm_locked" | "rate_limited";

/** Settings error; the HTTP boundary maps `status`/`code` and never echoes the value. */
export class ChatLimitsError extends Error {
  constructor(
    readonly code: ChatLimitsErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ChatLimitsError";
  }
}

export interface ChatLimitsSettingsEnv {
  /** `KNOWLIFY_CHAT_MAX_CONVERSATIONS`; `null` means the variable is unset. */
  maxConversations: number | null;
}

export interface ChatLimitsSettingsOptions {
  store: ChatLimitsStore;
  env: ChatLimitsSettingsEnv;
  /** `KNOWLIFY_LLM_LOCKED`: the environment wins and PUT answers 403 llm_locked. */
  locked: boolean;
  /** Existing sessions on this server, read on every GET/PUT response. */
  count: () => number;
  clock?: Clock;
  log?: Logger;
  /** Test seam; defaults to the documented 20 writes per minute. */
  writeRatePerMin?: number;
}

export interface ChatLimitsView {
  maxConversations: number;
  default: number;
  min: number;
  max: number;
  count: number;
  source: ChatLimitsSource;
  locked: boolean;
}

interface EffectiveLimit {
  value: number;
  source: ChatLimitsSource;
}

/**
 * Session limit settings (ADR-13): the database overrides the environment seed, the
 * default is 200, and reaching the limit blocks new sessions instead of deleting the
 * oldest one. A locked server ignores the saved value and refuses writes.
 */
export class ChatLimitsSettings {
  private stored: number | null = null;
  private readonly adminHits: number[] = [];
  private readonly writeRatePerMin: number;
  private readonly now: () => number;

  constructor(private readonly options: ChatLimitsSettingsOptions) {
    this.writeRatePerMin = Math.max(1, options.writeRatePerMin ?? ADMIN_RATE_PER_MIN);
    const clock = options.clock;
    this.now = clock ? () => clock.now() : Date.now;
  }

  /** Reads storage once at boot; a locked server never looks at the database. */
  bootstrap(): void {
    this.stored = null;
    if (this.options.locked) return;
    const raw = this.options.store.load();
    if (raw === null) return;
    try {
      this.stored = parseStored(raw);
    } catch {
      // A hand-edited row must not change the effective limit; the message has no value.
      this.options.log?.warn?.("the stored chat session limit is invalid; using the environment");
    }
  }

  /** Effective limit for the next turn; read per turn so a save needs no restart. */
  current(): number {
    return this.effective().value;
  }

  get(): ChatLimitsView {
    const effective = this.effective();
    return {
      maxConversations: effective.value,
      default: DEFAULT_MAX_CONVERSATIONS,
      min: MIN_MAX_CONVERSATIONS,
      max: MAX_MAX_CONVERSATIONS,
      count: this.options.count(),
      source: effective.source,
      locked: this.options.locked,
    };
  }

  /** Idempotent PUT: `{maxConversations: null}` removes the saved value. */
  update(raw: unknown): ChatLimitsView {
    this.assertUnlocked();
    this.consumeAdminLimit();
    const value = readUpdate(raw);
    this.options.store.save(value);
    this.stored = value;
    return this.get();
  }

  private effective(): EffectiveLimit {
    if (this.options.locked) return this.envOrDefault();
    if (this.stored !== null) return { value: this.stored, source: "db" };
    return this.envOrDefault();
  }

  private envOrDefault(): EffectiveLimit {
    const env = this.options.env.maxConversations;
    return env !== null
      ? { value: env, source: "env" }
      : { value: DEFAULT_MAX_CONVERSATIONS, source: "default" };
  }

  private assertUnlocked(): void {
    if (!this.options.locked) return;
    throw new ChatLimitsError("llm_locked", 403, "The LLM configuration is managed by the server environment");
  }

  private consumeAdminLimit(): void {
    const now = this.now();
    const since = now - RATE_WINDOW_MS;
    while (this.adminHits.length > 0 && (this.adminHits[0] ?? now) <= since) this.adminHits.shift();
    if (this.adminHits.length >= this.writeRatePerMin) {
      const oldest = this.adminHits[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
      throw new ChatLimitsError(
        "rate_limited",
        429,
        "Too many configuration requests; retry shortly",
        retryAfterSec,
      );
    }
    this.adminHits.push(now);
  }
}

function parseStored(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw invalidValue();
  return normalizeMaxConversations(Number(trimmed));
}

function readUpdate(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidBody();
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "maxConversations") throw invalidBody();
  const value = body.maxConversations;
  if (value === null) return null;
  if (typeof value !== "number") throw invalidValue();
  try {
    return normalizeMaxConversations(value);
  } catch (error) {
    if (error instanceof ValidationError) throw invalidValue();
    throw error;
  }
}

function invalidValue(): ChatLimitsError {
  return new ChatLimitsError(
    "invalid_value",
    400,
    `maxConversations must be an integer between ${MIN_MAX_CONVERSATIONS} and ${MAX_MAX_CONVERSATIONS}`,
  );
}

function invalidBody(): ChatLimitsError {
  return new ChatLimitsError("invalid_value", 400, "The request body must be {\"maxConversations\": number | null}");
}
