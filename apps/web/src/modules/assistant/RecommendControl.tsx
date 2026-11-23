import { useId } from "react";
import type { RecommendPreference } from "./types";
import "./suggestions.css";

const HELP = "Auto looks for books in your library when you ask for books to read. Book titles and short excerpts are sent to the model.";

/**
 * Ask + whole-library book suggestions: a one-shot "Recommend books" request and
 * the stored Auto/Off preference. With the library switch off the request is
 * disabled and the note says how to turn it on.
 */
export function RecommendControl({
  mode,
  onModeChange,
  armed,
  onArm,
  useLibrary,
  libraryAvailable,
  disabled = false,
}: {
  mode: RecommendPreference;
  onModeChange: (mode: RecommendPreference) => void;
  /** The next question asks for recommendations explicitly; cleared on send. */
  armed: boolean;
  onArm: (armed: boolean) => void;
  useLibrary: boolean;
  libraryAvailable: boolean;
  disabled?: boolean;
}) {
  const labelId = useId();
  const stateId = useId();
  const helpId = useId();
  const noteId = useId();
  const blocked = disabled || !useLibrary || !libraryAvailable;
  const note = !libraryAvailable
    ? "Book suggestions need the search index."
    : !useLibrary
      ? "Turn on Use my library to get book suggestions."
      : "";
  const describedBy = note ? `${helpId} ${noteId}` : helpId;
  const state = mode === "auto" ? "Auto" : "Off";
  return (
    <div className="asst-recommend">
      <div className="asst-recommend-row">
        <button
          type="button"
          className="ghost bordered asst-recommend-button"
          aria-pressed={armed}
          aria-describedby={describedBy}
          disabled={blocked}
          onClick={() => onArm(!armed)}
        >
          Recommend books
        </button>
        {useLibrary && libraryAvailable && (
          <div className="asst-recommend-pref">
            <span className="asst-recommend-label" id={labelId}>
              Book suggestions
            </span>
            <span className="asst-recommend-state" id={stateId}>
              {state}
            </span>
            <button
              type="button"
              className="tutor-switch"
              role="switch"
              aria-checked={mode === "auto"}
              aria-labelledby={`${labelId} ${stateId}`}
              aria-describedby={describedBy}
              disabled={disabled}
              onClick={() => onModeChange(mode === "auto" ? "off" : "auto")}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      <p className="asst-recommend-help" id={helpId}>
        {HELP}
      </p>
      {note && (
        <p className="asst-recommend-note" id={noteId}>
          {note}
        </p>
      )}
    </div>
  );
}
