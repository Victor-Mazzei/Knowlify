import { useEffect } from "react";

const NOTICE_MS = 5000;

/** Success messages leave on their own; errors stay until the next action. */
export function useAutoDismiss(value: string, clear: (value: string) => void, delay = NOTICE_MS) {
  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(() => clear(""), delay);
    return () => window.clearTimeout(timer);
  }, [value, clear, delay]);
}
