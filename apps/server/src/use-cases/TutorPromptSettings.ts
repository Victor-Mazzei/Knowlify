import {
  MAX_SYSTEM_PROMPT_CHARS,
  TUTOR_PERSONA_DEFAULT,
  TutorPromptError,
  normalizeCustomPersona,
  promptVersionFor,
} from "../domain/assistant/tutorPrompt.js";
import type { Clock, Logger } from "../ports/index.js";
import type { TutorPromptStore } from "../ports/llm-settings.js";

const ADMIN_RATE_PER_MIN = 20;
const RATE_WINDOW_MS = 60_000;

export interface TutorPromptView {
  /** `null` when the default persona is in use (or the server is locked). */
  custom: string | null;
  /** Editable default persona, without the fixed envelope. */
  default: string;
  version: string;
  maxChars: number;
  locked: boolean;
}

export interface TutorPromptSettingsOptions {
  store: TutorPromptStore;
  clock: Clock;
  log: Logger;
  locked: boolean;
}

/**
 * Assistant persona settings. The persona is not a secret, but it is user text: it is
 * never logged, and the fixed safety envelope is composed only at prompt build time.
 */
export class TutorPromptSettings {
  private stored: string | null = null;
  private readonly adminHits: number[] = [];

  constructor(private readonly options: TutorPromptSettingsOptions) {}

  /** Reads storage once at boot; a locked server ignores whatever is stored. */
  bootstrap(): void {
    this.stored = null;
    if (this.options.locked) return;
    const value = this.options.store.load();
    if (value === null) return;
    try {
      this.stored = normalizeCustomPersona(value);
    } catch {
      // A hand-edited row must not silently change every prompt with invalid text.
      this.options.log.warn?.("the stored tutor prompt is invalid; using the default");
    }
  }

  get(): TutorPromptView {
    const custom = this.current();
    return {
      custom,
      default: TUTOR_PERSONA_DEFAULT,
      version: promptVersionFor(custom),
      maxChars: MAX_SYSTEM_PROMPT_CHARS,
      locked: this.options.locked,
    };
  }

  /** Effective custom persona for the next turn; `null` means the default. */
  current(): string | null {
    return this.options.locked ? null : this.stored;
  }

  /** Idempotent PUT: `{systemPrompt: null}` restores the default. */
  update(input: unknown): TutorPromptView {
    this.assertUnlocked();
    this.consumeAdminLimit();
    const next = normalizeCustomPersona(readSystemPrompt(input));
    this.options.store.save(next);
    this.stored = next;
    return this.get();
  }

  private assertUnlocked(): void {
    if (!this.options.locked) return;
    throw new TutorPromptError("llm_locked", 403, "The LLM configuration is managed by the server environment");
  }

  private consumeAdminLimit(): void {
    const now = this.options.clock.now();
    const since = now - RATE_WINDOW_MS;
    while (this.adminHits.length > 0 && (this.adminHits[0] ?? now) <= since) this.adminHits.shift();
    if (this.adminHits.length >= ADMIN_RATE_PER_MIN) {
      const oldest = this.adminHits[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
      throw new TutorPromptError("rate_limited", 429, "Too many configuration requests; retry shortly", retryAfterSec);
    }
    this.adminHits.push(now);
  }
}

function readSystemPrompt(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidBody();
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "systemPrompt") throw invalidBody();
  return (input as Record<string, unknown>).systemPrompt;
}

function invalidBody(): TutorPromptError {
  return new TutorPromptError("invalid_value", 400, "The request body must be {\"systemPrompt\": string | null}");
}
