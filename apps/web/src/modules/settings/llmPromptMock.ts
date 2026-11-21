import { ApiError } from "../../services/api";
import { LLM_PROMPT_MAX_CHARS, type LlmPromptView } from "./llmTypes";

const DEFAULT_PROMPT_VERSION = "feynman-2";

const MOCK_DEFAULT_PROMPT = [
  "You are a patient tutor who helps the reader understand their books.",
  "Use the Feynman method: explain plainly, give one concrete example, and finish with a short question that checks understanding.",
  "Answer in the reader's language and keep replies concise.",
].join("\n\n");

const MOCK_CUSTOM_PROMPT = "Answer like a Socratic tutor: reply with one question at a time and no long explanations.";

const normalizePrompt = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** Stable 8-hex digest used only by the mock; the server owns the real version. */
const promptVersion = (text: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `custom-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export const defaultPrompt = (): LlmPromptView => ({
  custom: null,
  default: MOCK_DEFAULT_PROMPT,
  version: DEFAULT_PROMPT_VERSION,
  maxChars: LLM_PROMPT_MAX_CHARS,
  locked: false,
});

export const customPrompt = (): LlmPromptView => ({
  ...defaultPrompt(),
  custom: MOCK_CUSTOM_PROMPT,
  version: promptVersion(MOCK_CUSTOM_PROMPT),
});

/** Mirrors the `PUT /settings/llm/prompt` validation; returns the next prompt view. */
export function applyPromptSave(current: LlmPromptView, body: Record<string, unknown> | null): LlmPromptView {
  if (body === null || !("systemPrompt" in body)) {
    throw new ApiError(400, "systemPrompt is required.");
  }
  const value = body.systemPrompt;
  if (value !== null && typeof value !== "string") {
    throw new ApiError(400, "The system prompt must be a string or null.");
  }
  let custom: string | null = null;
  if (typeof value === "string") {
    const normalized = normalizePrompt(value);
    if (!normalized) throw new ApiError(400, "The system prompt cannot be empty.");
    if (normalized.length > LLM_PROMPT_MAX_CHARS) {
      throw new ApiError(400, `Use at most ${LLM_PROMPT_MAX_CHARS} characters.`);
    }
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(normalized)) {
      throw new ApiError(400, "The system prompt contains unsupported control characters.");
    }
    if (normalized !== normalizePrompt(current.default)) custom = normalized;
  }
  return {
    ...current,
    custom,
    version: custom ? promptVersion(custom) : DEFAULT_PROMPT_VERSION,
  };
}
