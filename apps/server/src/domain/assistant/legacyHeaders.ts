import type { LlmHeaderStored } from "./LlmHeaders.js";

/**
 * Header written by Knowlify before custom headers existed (migration seed only).
 * It is the only place in the source that still names the old provider alias; the
 * public export allowlists this single line until 2.0 removes both.
 */
export const LEGACY_SESSION_HEADER: LlmHeaderStored = {
  name: "x-opencode-session",
  value: "{{conversationId}}",
};
