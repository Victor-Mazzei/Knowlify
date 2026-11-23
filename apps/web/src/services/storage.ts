import type { ChatMode } from "../modules/assistant/types";

/**
 * Small, typed preferences owned by the tutor. Each key stores one short value:
 * the last mode, whether the first-use hint was dismissed and the Ask library
 * switch. No book id, title, question or excerpt is ever stored here.
 */
export const TUTOR_MODE_KEY = "knowlify.tutor.mode";
export const TUTOR_HINT_KEY = "knowlify.tutor.hintDismissed";
export const TUTOR_ASK_LIBRARY_KEY = "knowlify.tutor.askUseLibrary";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    // Blocked storage only loses the preference.
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage only loses the preference.
  }
};

/** Last mode the person chose; `session` when nothing valid is stored. */
export function readTutorMode(): ChatMode {
  return read(TUTOR_MODE_KEY) === "ask" ? "ask" : "session";
}

export function saveTutorMode(mode: ChatMode): void {
  write(TUTOR_MODE_KEY, mode);
}

export function readTutorHintDismissed(): boolean {
  return read(TUTOR_HINT_KEY) === "1";
}

export function dismissTutorHint(): void {
  write(TUTOR_HINT_KEY, "1");
}

/** Ask defaults to using the library; only the exact `"0"` turns it off. */
export function readAskUseLibrary(): boolean {
  return read(TUTOR_ASK_LIBRARY_KEY) !== "0";
}

export function saveAskUseLibrary(useLibrary: boolean): void {
  write(TUTOR_ASK_LIBRARY_KEY, useLibrary ? "1" : "0");
}
