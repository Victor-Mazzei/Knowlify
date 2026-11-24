import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useChatStatusContext } from "../modules/assistant/useChatStatus";
import { IndexChip } from "../modules/indexing/IndexChip";
import { useIndexStatusContext } from "../modules/indexing/IndexStatusContext";
import { useApi } from "../services/api";
import type { Credentials } from "../types";
import type { ApiFn } from "./dialogs";
import { Logo } from "./Logo";
import { useScanStatusContext } from "./ScanStatusContext";
import { ThemeToggle } from "./ThemeToggle";
import { useMediaQuery } from "./useMediaQuery";
import { WorkspaceStatusProvider, useHasWorkspaceStatus } from "./WorkspaceStatus";
import { COMPACT_HEADER_QUERY } from "../modules/assistant/tutorLayout";

export type NavKey = "library" | "ask" | "notes" | "news" | "settings";

/** The nav item that owns a path; unknown paths fall back to the library. */
export function navKeyFor(pathname: string): NavKey {
  if (pathname === "/ask" || pathname.startsWith("/ask/")) return "ask";
  if (pathname === "/notes" || pathname.startsWith("/notes/")) return "notes";
  if (pathname === "/news" || pathname.startsWith("/news/")) return "news";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  return "library";
}

type AppShellProps = {
  credentials: Credentials;
  onLogout: () => void;
  /** Optional shared API (tests and dev fixtures) instead of opening a second one. */
  api?: ApiFn;
  /** Optional inline content for shells rendered outside a route tree. */
  children?: ReactNode;
};

/**
 * Persistent signed-in layout: header, navigation and the route outlet. Mounted
 * once by the router so moving between pages never unmounts the shared chrome.
 * Workspace status is owned above the routes; the fallback keeps direct renders
 * (tests and fixtures) self-contained, exactly as before the provider existed.
 */
export function AppShell(props: AppShellProps) {
  if (useHasWorkspaceStatus()) return <AppShellLayout {...props} />;
  return (
    <WorkspaceStatusProvider credentials={props.credentials} onLogout={props.onLogout} api={props.api}>
      <AppShellLayout {...props} />
    </WorkspaceStatusProvider>
  );
}

function AppShellLayout({ credentials, onLogout, api: apiOverride, children }: AppShellProps) {
  const liveApi = useApi(credentials, onLogout);
  const api = apiOverride ?? liveApi;
  const chat = useChatStatusContext();
  const index = useIndexStatusContext();
  const scan = useScanStatusContext();
  const location = useLocation();
  const active = navKeyFor(location.pathname);
  const current = (key: NavKey) => (active === key ? ("page" as const) : undefined);
  // Below this height the /ask page gives the app bar a single compact row,
  // even on a wide desktop. A narrow phone also uses it because the wrapped
  // header is tall there.
  const compactViewport = useMediaQuery(COMPACT_HEADER_QUERY);
  const compactHeader = active === "ask" && compactViewport;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!compactHeader) setMenuOpen(false);
  }, [compactHeader]);

  // A disclosure is keyboard-operable: Escape dismisses it, and the trigger keeps focus.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenuOpen(false);
      menuTrigger.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen]);

  const nav = (
    <nav className="nav" aria-label="Primary">
      <Link to="/" className="nav-link" aria-current={current("library")}>
        Library
      </Link>
      {chat.enabled && (
        <Link to="/ask" className="nav-link" aria-current={current("ask")}>
          Ask
        </Link>
      )}
      <Link to="/notes" className="nav-link" aria-current={current("notes")}>
        Notes
      </Link>
      <Link to="/news" className="nav-link" aria-current={current("news")}>
        News
      </Link>
      <Link to="/settings" className="nav-link" aria-current={current("settings")}>
        Settings
      </Link>
    </nav>
  );

  const actions = (
    <div className="header-actions">
      <IndexChip
        scanStatus={scan.status}
        index={index.available ? index.status : null}
        scanError={scan.error}
        api={api}
        refresh={index.refresh}
      />
      <ThemeToggle />
      <button className="ghost" onClick={onLogout}>
        Log out
      </button>
    </div>
  );

  return (
    <div
      className={[
        active === "ask" ? "app app-ask" : "app",
        compactHeader ? "app-compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header>
        <Link to="/" className="brand">
          <Logo size={20} />
          Knowlify
        </Link>
        {compactHeader ? (
          <>
            <button
              ref={menuTrigger}
              type="button"
              className="app-menu-trigger"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? "app-menu" : undefined}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
                <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              Menu
            </button>
            {menuOpen && (
              <div id="app-menu" className="app-menu">
                {nav}
                {actions}
              </div>
            )}
          </>
        ) : (
          <>
            {nav}
            {actions}
          </>
        )}
      </header>
      {children ?? <Outlet />}
    </div>
  );
}
