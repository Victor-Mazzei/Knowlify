import type { ChatMode } from "./types";

/**
 * Always-visible state line: whether the chat is saved, whether the library is
 * used in Ask, and the scope. It never hides behind a tooltip.
 */
export function ModeStatus({
  mode,
  useLibrary,
  scopeLabel,
  sessionTitle,
  hasSession,
}: {
  mode: ChatMode;
  useLibrary: boolean;
  scopeLabel: string;
  sessionTitle?: string;
  /** A session exists (resumed or already answered). */
  hasSession: boolean;
}) {
  if (mode === "ask") {
    return (
      <p className="tutor-state" data-mode="ask">
        <span className="tutor-state-dot" data-saved="false" aria-hidden="true" />
        <span>
          Ask · not saved · library {useLibrary ? "on" : "off"}
        </span>
        <span className="tutor-state-scope">{scopeLabel}</span>
      </p>
    );
  }
  if (!hasSession) {
    return (
      <p className="tutor-state" data-mode="session">
        <span className="tutor-state-dot" data-saved="true" aria-hidden="true" />
        <span>New session · saves with your first answer</span>
        <span className="tutor-state-scope">{scopeLabel}</span>
      </p>
    );
  }
  return (
    <p className="tutor-state" data-mode="session">
      <span className="tutor-state-dot" data-saved="true" aria-hidden="true" />
      <span>Session · saved · {sessionTitle || "Untitled session"}</span>
      <span className="tutor-state-scope">{scopeLabel}</span>
    </p>
  );
}
