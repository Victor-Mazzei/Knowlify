import { useCallback, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { Progress } from "../../types";

export function useReadingProgress(api: ApiFn, bookId: string, initial: Progress) {
  const latestProgress = useRef(initial);
  const timer = useRef<number>();
  // Live value for the on-screen indicator; the PUT still waits for the debounce.
  const [percentage, setPercentage] = useState(initial.percentage);

  const save = useCallback(
    (value: Progress) => {
      void api(`/api/books/${bookId}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      }).catch(() => {
        // Progress is best effort; reading must not be interrupted by a failed save.
      });
    },
    [api, bookId],
  );

  const flushProgress = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    save(latestProgress.current);
  }, [save]);

  const scheduleProgress = useCallback(
    (value: Progress) => {
      latestProgress.current = value;
      setPercentage(value.percentage);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        save(latestProgress.current);
      }, 500);
    },
    [save],
  );

  return { scheduleProgress, flushProgress, latestProgress, percentage };
}
