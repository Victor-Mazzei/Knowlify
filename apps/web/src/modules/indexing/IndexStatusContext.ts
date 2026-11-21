import { createContext, useContext } from "react";
import type { IndexStatusState } from "./useIndexStatus";

/** Shared poller result so the header chip and the Settings card stay in sync. */
export const IndexStatusContext = createContext<IndexStatusState | null>(null);

export function useIndexStatusContext(): IndexStatusState {
  const value = useContext(IndexStatusContext);
  if (!value) throw new Error("useIndexStatusContext must be used inside the workspace status provider.");
  return value;
}

/** For pages that remain usable when rendered outside the shell (tests and fixtures). */
export function useIndexStatusContextOptional(): IndexStatusState | null {
  return useContext(IndexStatusContext);
}
