import { useCallback, useState } from "react";
import type { LlmApi } from "./llmApi";
import { describeError } from "./llmApi";
import type { LlmPromptView } from "./llmTypes";

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const normalizePrompt = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** Client-side mirror of the server rules; the server stays the source of truth. */
export function promptProblem(draft: string, maxChars: number): string {
  const text = normalizePrompt(draft);
  if (!text) return "Enter a prompt, or reset to the default.";
  if (text.length > maxChars) return `Use at most ${maxChars} characters.`;
  if (CONTROL_CHARS.test(text)) return "Remove unsupported control characters.";
  return "";
}

/**
 * Owns the prompt draft and its save lifecycle independently from the connection
 * form: saving one never submits the other. The saved prompt is the version state.
 */
export function usePromptSettings(client: LlmApi, initial: LlmPromptView) {
  const [prompt, setPrompt] = useState(initial);
  const [draft, setDraft] = useState(() => initial.custom ?? initial.default);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const currentText = prompt.custom ?? prompt.default;
  const problem = promptProblem(draft, prompt.maxChars);
  const changed = normalizePrompt(draft) !== normalizePrompt(currentText);
  const usingDefault = prompt.custom === null;
  const canSave = !prompt.locked && !saving && changed && !problem;

  const change = useCallback((value: string) => {
    setDraft(value);
    setError("");
    setNotice("");
  }, []);

  const reset = useCallback(() => {
    setDraft(prompt.default);
    setError("");
    setNotice("");
  }, [prompt.default]);

  const save = useCallback(async () => {
    if (prompt.locked) return;
    const issue = promptProblem(draft, prompt.maxChars);
    if (issue) {
      setError(issue);
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const normalized = normalizePrompt(draft);
      const body = normalized === normalizePrompt(prompt.default) ? null : normalized;
      const next = await client.savePrompt(body);
      setPrompt(next);
      setDraft(next.custom ?? next.default);
      setNotice(next.custom === null ? "Saved. Using the default prompt." : "Saved. Custom prompt in use.");
    } catch (reason: unknown) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  }, [client, draft, prompt.default, prompt.locked, prompt.maxChars]);

  return {
    prompt,
    draft,
    usingDefault,
    problem,
    changed,
    canSave,
    saving,
    error,
    notice,
    change,
    reset,
    save,
  };
}

export type PromptSettingsState = ReturnType<typeof usePromptSettings>;
