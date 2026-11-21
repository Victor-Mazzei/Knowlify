import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { chatApi } from "../modules/assistant/chatApi";
import { ChatStatusContext, useChatStatus } from "../modules/assistant/useChatStatus";
import { useSources } from "../modules/folders/useSources";
import { IndexStatusContext } from "../modules/indexing/IndexStatusContext";
import { useIndexStatus } from "../modules/indexing/useIndexStatus";
import { useApi } from "../services/api";
import type { Credentials } from "../types";
import type { ApiFn } from "./dialogs";
import { ScanStatusContext } from "./ScanStatusContext";
import { useScanStatus } from "./useScanStatus";

const WorkspaceStatusContext = createContext(false);

/** True when status providers are already mounted above the current tree. */
export function useHasWorkspaceStatus(): boolean {
  return useContext(WorkspaceStatusContext);
}

/**
 * Chat, scan, index and folder state for the signed-in session. It lives above
 * the routes so opening the reader (which renders outside the shell) does not
 * drop the status and refetch it on the way back.
 */
export function WorkspaceStatusProvider({
  credentials,
  onLogout,
  api: apiOverride,
  children,
}: {
  credentials: Credentials;
  onLogout: () => void;
  /** Optional shared API (tests and dev fixtures) instead of opening a second one. */
  api?: ApiFn;
  children: ReactNode;
}) {
  const liveApi = useApi(credentials, onLogout);
  const api = apiOverride ?? liveApi;
  const chat = useChatStatus(chatApi(api));
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [sourcesRevision, setSourcesRevision] = useState(0);
  const onLibraryChange = useCallback(() => setLibraryRevision((value) => value + 1), []);
  const onSourcesChange = useCallback(() => setSourcesRevision((value) => value + 1), []);
  const { status: scanStatus, error: scanError, refresh: refreshScan, rescan, wake } = useScanStatus(
    api,
    onLibraryChange,
    onSourcesChange,
  );
  const index = useIndexStatus(api, scanStatus.scanning);
  const { sources, loading: sourcesLoading, error: sourcesError, refresh: refreshSources } = useSources(api, sourcesRevision);
  const scanValue = useMemo(
    () => ({
      status: scanStatus,
      error: scanError,
      refresh: refreshScan,
      rescan,
      wake,
      libraryRevision,
      sourcesRevision,
      sources,
      sourcesLoading,
      sourcesError,
      refreshSources,
    }),
    [
      scanStatus,
      scanError,
      refreshScan,
      rescan,
      wake,
      libraryRevision,
      sourcesRevision,
      sources,
      sourcesLoading,
      sourcesError,
      refreshSources,
    ],
  );
  return (
    <WorkspaceStatusContext.Provider value={true}>
      <ChatStatusContext.Provider value={chat}>
        <IndexStatusContext.Provider value={index}>
          <ScanStatusContext.Provider value={scanValue}>{children}</ScanStatusContext.Provider>
        </IndexStatusContext.Provider>
      </ChatStatusContext.Provider>
    </WorkspaceStatusContext.Provider>
  );
}
