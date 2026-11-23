import { useState } from "react";
import { dismissTutorHint, readTutorHintDismissed } from "../../services/storage";

const HINT =
  "Ask is for quick questions and is not saved. Session keeps your history so you can come back. In Ask, you choose if your library is used.";

/** One-time explanation of the two modes. "Got it" stores the dismissal and never shows it again. */
export function FirstUseHint() {
  const [visible, setVisible] = useState(() => !readTutorHintDismissed());
  if (!visible) return null;
  return (
    <aside className="tutor-first-use" aria-label="About chat modes">
      <p>{HINT}</p>
      <button
        type="button"
        className="ghost bordered"
        onClick={() => {
          dismissTutorHint();
          setVisible(false);
        }}
      >
        Got it
      </button>
    </aside>
  );
}
