import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RecommendPreference } from "./types";
import "./suggestions.css";

const BUTTON_HELP = "Show book cards for your next message.";
const SETTINGS_HELP =
  "Auto: the tutor shows book cards when you ask for a recommendation. Off: it never shows book cards.";

/**
 * Ask + whole-library book suggestions. The one-shot "Suggest books" request
 * stays next to the question; the stored Auto/Off preference lives in the
 * composer settings popover so the main view keeps one clear action.
 */
export function RecommendControl({
  armed,
  onArm,
  useLibrary,
  libraryAvailable,
  onEnableLibrary,
  disabled = false,
}: {
  /** The next question asks for book cards explicitly; cleared on send. */
  armed: boolean;
  onArm: (armed: boolean) => void;
  useLibrary: boolean;
  libraryAvailable: boolean;
  onEnableLibrary?: () => void;
  disabled?: boolean;
}) {
  const helpId = useId();

  if (!libraryAvailable) {
    return <p className="asst-recommend-note">Book suggestions need the search index.</p>;
  }

  if (!useLibrary) {
    return (
      <div className="asst-recommend-off">
        <p>Book suggestions need Search my books.</p>
        {onEnableLibrary && (
          <button type="button" className="ghost bordered" onClick={onEnableLibrary}>
            Turn on Search my books
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="asst-recommend">
      <button
        type="button"
        className="ghost bordered asst-recommend-button"
        aria-pressed={armed}
        aria-describedby={helpId}
        disabled={disabled}
        onClick={() => onArm(!armed)}
      >
        Suggest books
      </button>
      <p className="asst-recommend-help" id={helpId}>
        {BUTTON_HELP}
      </p>
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 4.5h2M8.5 4.5h5M2.5 8h5M10.5 8h3M2.5 11.5h2M8.5 11.5h5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="6.5" cy="4.5" r="1.5" fill="currentColor" />
      <circle cx="9" cy="8" r="1.5" fill="currentColor" />
      <circle cx="6.5" cy="11.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

/**
 * Composer settings popover. It is a non-modal dialog: focus moves to the
 * switch when it opens, Escape closes it and returns focus to the gear, and a
 * click outside or tabbing away closes it without trapping the person.
 */
export function ComposerSettings({
  mode,
  onModeChange,
  disabled = false,
}: {
  mode: RecommendPreference;
  onModeChange: (mode: RecommendPreference) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const labelId = useId();
  const helpId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (container.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, close]);

  const state = mode === "auto" ? "Auto" : "Off";

  return (
    <div
      ref={container}
      className="asst-settings"
      data-tutor-settings={open ? "open" : undefined}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="ghost bordered asst-settings-trigger"
        aria-label="Answer settings"
        title="Answer settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <SettingsIcon />
      </button>
      {open && (
        <div ref={panel} id={panelId} className="asst-settings-panel" role="dialog" aria-label="Answer settings">
          <div className="asst-settings-row">
            <span className="asst-settings-label" id={labelId}>
              Suggest books from my library
            </span>
            <span className="asst-settings-state">{state}</span>
            <button
              type="button"
              className="tutor-switch"
              role="switch"
              aria-checked={mode === "auto"}
              aria-labelledby={labelId}
              aria-describedby={helpId}
              disabled={disabled}
              data-autofocus
              onClick={() => onModeChange(mode === "auto" ? "off" : "auto")}
            >
              <span aria-hidden="true" />
            </button>
          </div>
          <p className="asst-settings-help" id={helpId}>
            {SETTINGS_HELP}
          </p>
        </div>
      )}
    </div>
  );
}
