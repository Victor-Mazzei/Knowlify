import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { useTutorOptional } from "./TutorContext";

/** Blocking limit state shared by the session list and the new-session composer. */
export function SessionLimitNotice({
  limit,
  count,
  blocked = false,
}: {
  limit: number;
  count: number;
  /** True when the composer for a new session is disabled by this limit. */
  blocked?: boolean;
}) {
  const tutor = useTutorOptional();
  const reduced = count > limit;
  // The drawer would cover the settings card it sends the reader to.
  const leaveTutor = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    tutor?.closeTutor();
  };
  return (
    <p className="tutor-limit" role="status" data-blocked={blocked}>
      {reduced ? (
        <>
          You have {count} sessions; the limit is {limit}. Existing sessions still work. Raise the limit in{" "}
          <Link className="tutor-limit-link" to="/settings/ai" onClick={leaveTutor}>
            Settings → AI
          </Link>
          {"."}
        </>
      ) : (
        <>
          You reached the session limit ({limit}). Delete a session, or raise the limit in{" "}
          <Link className="tutor-limit-link" to="/settings/ai" onClick={leaveTutor}>
            Settings → AI
          </Link>
          {"."}
        </>
      )}
    </p>
  );
}
