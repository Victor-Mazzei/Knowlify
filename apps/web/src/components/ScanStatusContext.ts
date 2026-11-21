import { createContext, useContext } from "react";
import type { ScanStatus, Source } from "../types";

/**
 * Scan state owned by the persistent shell. Pages can request a rescan or react
 * to revisions without owning a second poller.
 */
export type ScanStatusContextValue = {
  status: ScanStatus;
  error: boolean;
  refresh: () => Promise<ScanStatus>;
  rescan: () => Promise<void>;
  wake: () => void;
  /** Increments when a scan finishes; the library reloads its rows. */
  libraryRevision: number;
  /** Increments when source metadata should be read again. */
  sourcesRevision: number;
  /** Library folders, owned by the shell so Settings opens with the list ready. */
  sources: Source[];
  sourcesLoading: boolean;
  sourcesError: string;
  refreshSources: () => Promise<void>;
};

export const ScanStatusContext = createContext<ScanStatusContextValue | null>(null);

export function useScanStatusContext(): ScanStatusContextValue {
  const value = useContext(ScanStatusContext);
  if (!value) throw new Error("useScanStatusContext must be used inside the workspace status provider.");
  return value;
}

/** For pages that remain usable when rendered outside the shell (tests and fixtures). */
export function useScanStatusContextOptional(): ScanStatusContextValue | null {
  return useContext(ScanStatusContext);
}
