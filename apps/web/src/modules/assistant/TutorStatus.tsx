/**
 * "The tutor is working" indicator. Three dots pulse in sequence; the dots are
 * decorative and the hidden status text is what screen readers announce. The
 * dots disappear once answer text starts arriving, so the status then only
 * names the writing phase.
 */
export type TutorPhase = "thinking" | "writing";

export function TutorStatus({ phase }: { phase: TutorPhase }) {
  return (
    <span className="asst-status" role="status">
      {phase === "thinking" ? (
        <span className="asst-status-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : null}
      <span className="asst-visually-hidden">{phase === "thinking" ? "Thinking" : "Writing"}</span>
    </span>
  );
}
