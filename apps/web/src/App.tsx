import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { clearCredentials, readCredentials, saveCredentials, verifyCredentials } from "./services/api";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WorkspaceStatusProvider } from "./components/WorkspaceStatus";
import { Login } from "./modules/auth/Login";
import { clearChatStatusCache } from "./modules/assistant/useChatStatus";
import { TutorProvider } from "./modules/assistant/TutorProvider";
import { TutorDock } from "./modules/assistant/TutorDock";
import { AssistantPage } from "./modules/assistant/AssistantPage";
import { Library } from "./modules/library/Library";
import { Reader } from "./modules/reader/Reader";
import { NotesPage } from "./modules/notes/NotesPage";
import { NewsPage } from "./modules/news/NewsPage";
import { SettingsEntry } from "./modules/settings/SettingsEntry";
import { SettingsPage } from "./modules/settings/SettingsPage";
import { BookDetailsSkeleton } from "./modules/book/BookDetailsSkeleton";
import type { Credentials } from "./types";
import "./styles.css";
import "./modules/book/bookDetails.css";

const BookDetailsPage = lazy(() =>
  import("./modules/book/BookDetailsPage").then((module) => ({ default: module.BookDetailsPage })),
);

export default function App() {
  const [credentials, setCredentials] = useState<Credentials | null>(readCredentials);
  /** Session identity travels with the callbacks rendered for it. */
  const latestSessionId = useRef(0);
  const [sessionId, setSessionId] = useState(0);

  const beginSession = useCallback(() => {
    latestSessionId.current += 1;
    setSessionId(latestSessionId.current);
  }, []);

  const logout = useCallback(() => {
    // A request that outlived its session must not end the session that
    // replaced it, even when the user signed in again with the same credentials.
    if (sessionId !== latestSessionId.current) return;
    beginSession();
    clearChatStatusCache();
    clearCredentials();
    setCredentials(null);
  }, [beginSession, sessionId]);

  async function login(value: Credentials) {
    await verifyCredentials(value);
    saveCredentials(value);
    // Invalidate previous callbacks before React commits the new session.
    beginSession();
    setCredentials(value);
  }
  const updateCredentials = useCallback((value: Credentials) => {
    saveCredentials(value);
    beginSession();
    setCredentials(value);
  }, [beginSession]);
  if (!credentials) return <Login onLogin={login} />;
  return <ErrorBoundary>
    <WorkspaceStatusProvider credentials={credentials} onLogout={logout}>
      <TutorProvider credentials={credentials} onLogout={logout}>
        <div id="tutor-main">
          <Routes>
            <Route path="/folders" element={<Navigate to="/settings/folders" replace />} />
            <Route element={<AppShell credentials={credentials} onLogout={logout} />}>
              <Route path="/" element={<Library credentials={credentials} onLogout={logout} />} />
              <Route path="/ask" element={<AssistantPage />} />
              <Route path="/news" element={<NewsPage credentials={credentials} onLogout={logout} />} />
              <Route path="/settings" element={<SettingsEntry />} />
              <Route
                path="/settings/:section"
                element={
                  <SettingsPage credentials={credentials} onLogout={logout} onCredentialsChange={updateCredentials} />
                }
              />
              <Route path="/notes" element={<NotesPage credentials={credentials} onLogout={logout} />} />
              <Route
                path="/book/:id"
                element={
                  <Suspense fallback={<BookDetailsSkeleton />}>
                    <BookDetailsPage credentials={credentials} onLogout={logout} />
                  </Suspense>
                }
              />
              <Route path="*" element={<Library credentials={credentials} onLogout={logout} />} />
            </Route>
            <Route path="/read/:id" element={<Reader credentials={credentials} onLogout={logout} />} />
          </Routes>
        </div>
        <TutorDock />
      </TutorProvider>
    </WorkspaceStatusProvider>
  </ErrorBoundary>;
}
