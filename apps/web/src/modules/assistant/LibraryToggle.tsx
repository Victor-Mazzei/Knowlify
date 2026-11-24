import { useId } from "react";

export const ASK_LIBRARY_ON = "Search my books is on: answers can cite your books.";
export const ASK_LIBRARY_OFF = "Search my books is off: answers do not use your books.";

export const LIBRARY_HELP =
  "On: the tutor reads passages from your books and sends them to the AI provider. Off: the tutor answers without your books.";

/**
 * Ask-only "Search my books" switch. The help sentence is visible and linked
 * with `aria-describedby`; the switch itself is a native button with
 * `role="switch"`.
 */
export function LibraryToggle({
  checked,
  onChange,
  disabled = false,
  libraryAvailable = true,
  hasExcerpt = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** False when the server has no search index: the switch stays usable but the search does not run. */
  libraryAvailable?: boolean;
  hasExcerpt?: boolean;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="tutor-library-toggle">
      <div className="tutor-library-row">
        <span className="tutor-library-label" id={labelId}>
          Search my books
        </span>
        <button
          type="button"
          className="tutor-switch"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <p className="tutor-library-desc" id={descriptionId}>
        {LIBRARY_HELP}
      </p>
      {!libraryAvailable && <p className="tutor-library-note">Search is off. Only attached text is used.</p>}
      {hasExcerpt && <p className="tutor-library-note">Attached text is sent to the model.</p>}
    </div>
  );
}
