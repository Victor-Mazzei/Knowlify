import { useEffect, useRef } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { ConversationSummary } from "./types";

/**
 * Looks up the most recent session of one book, once per slot. A missing list
 * (older server, empty history or a failed read) still marks the slot checked:
 * the tutor keeps working without resuming.
 */
export function useLatestSession({
  api,
  bookId,
  enabled,
  onResume,
  onSettled,
}: {
  api: ApiFn;
  bookId?: string;
  enabled: boolean;
  onResume: (summary: ConversationSummary) => void;
  onSettled?: () => void;
}) {
  const started = useRef(false);
  const resumeRef = useRef(onResume);
  const settledRef = useRef(onSettled);
  resumeRef.current = onResume;
  settledRef.current = onSettled;

  useEffect(() => {
    if (!enabled || !bookId || started.current) return;
    started.current = true;
    let cancelled = false;
    api(`/api/chat/conversations?bookId=${encodeURIComponent(bookId)}&limit=1`)
      .then((response) => response.json() as Promise<ConversationSummary[]>)
      .then((list) => {
        if (cancelled) return;
        const latest = Array.isArray(list) ? list[0] : undefined;
        if (latest?.id) resumeRef.current(latest);
      })
      .catch(() => {
        // Resuming is an improvement, not a requirement.
      })
      .finally(() => {
        if (!cancelled) settledRef.current?.();
      });
    return () => {
      cancelled = true;
    };
  }, [api, bookId, enabled]);
}
