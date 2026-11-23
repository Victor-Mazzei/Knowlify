import { useId } from "react";
import type { ChatMode } from "./types";

/**
 * Ask/Session selector. Native radios keep arrow-key navigation and the group
 * semantics; the description under each option is always visible and linked
 * with `aria-describedby`.
 */
export function ModeSwitch({
  value,
  onChange,
  disabled = false,
}: {
  value: ChatMode;
  onChange: (mode: ChatMode) => void;
  disabled?: boolean;
}) {
  const name = useId();
  const askId = useId();
  const sessionId = useId();
  const options: ChatMode[] = ["ask", "session"];
  return (
    <div
      className="tutor-mode-switch"
      role="radiogroup"
      aria-label="Chat mode"
      onKeyDown={(event) => {
        const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
        if (!keys.includes(event.key) || disabled) return;
        event.preventDefault();
        const current = options.indexOf(value);
        const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
        const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
        let next = current;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = options.length - 1;
        else if (forward) next = (current + 1) % options.length;
        else if (backward) next = (current - 1 + options.length) % options.length;
        const target = options[next];
        if (!target) return;
        onChange(target);
        const group = event.currentTarget;
        group.querySelector<HTMLInputElement>(`input[value="${target}"]`)?.focus();
      }}
    >
      <label className="tutor-mode-option" data-active={value === "ask"}>
        <input
          type="radio"
          name={name}
          value="ask"
          checked={value === "ask"}
          disabled={disabled}
          aria-label="Ask"
          aria-describedby={askId}
          onChange={() => onChange("ask")}
        />
        <span className="tutor-mode-name">Ask</span>
        <span className="tutor-mode-desc" id={askId}>
          Quick question: nothing is saved
        </span>
      </label>
      <label className="tutor-mode-option" data-active={value === "session"}>
        <input
          type="radio"
          name={name}
          value="session"
          checked={value === "session"}
          disabled={disabled}
          aria-label="Session"
          aria-describedby={sessionId}
          onChange={() => onChange("session")}
        />
        <span className="tutor-mode-name">Session</span>
        <span className="tutor-mode-desc" id={sessionId}>
          Keeps the history and context; you can resume later
        </span>
      </label>
    </div>
  );
}
