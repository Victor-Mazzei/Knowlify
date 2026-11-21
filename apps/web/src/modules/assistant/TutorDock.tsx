import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { TutorPanel } from "./TutorPanel";
import { useTutor } from "./TutorProvider";
import { useMediaQuery } from "./useTutorMedia";
import "./tutor.css";

const DOCK_TARGET = "tutor-slot-dock";
const PAGE_TARGET = "tutor-slot-page";

const focusableIn = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(
    "button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.closest("[hidden]"));

/**
 * Floating entry point and the fixed drawer. The panel is lazily created on the
 * first open and then only hidden, so conversation state and streams survive
 * closing the drawer and moving between routes (including the reader).
 */
export function TutorDock() {
  const tutor = useTutor();
  const location = useLocation();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const readerRoute = location.pathname.startsWith("/read/");
  const dock = tutor.surface === "dock";
  const needed = tutor.enabled && (dock ? tutor.open : Boolean(tutor.status?.scopes.library));
  const [mounted, setMounted] = useState(needed);
  const renderPanel = mounted || needed;
  const modal = dock && isMobile && tutor.open;

  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "tutor-portal-host";
    return element;
  });
  const fab = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(tutor.open);

  useEffect(() => {
    // On the modal layout the FAB is unmounted while open; focus the new one on close.
    if (wasOpen.current && !tutor.open && dock) {
      const active = document.activeElement;
      const panel = document.getElementById("tutor-panel");
      if (!active || active === document.body || panel?.contains(active)) {
        const readerToggle = document.getElementById("tutor-reader-toggle");
        (fab.current ?? readerToggle)?.focus();
      }
    }
    wasOpen.current = tutor.open;
  }, [tutor.open, dock]);

  useEffect(() => {
    if (needed) setMounted(true);
  }, [needed]);

  useLayoutEffect(() => {
    if (!renderPanel) return;
    const target = document.getElementById(dock ? DOCK_TARGET : PAGE_TARGET);
    if (target && host.parentElement !== target) target.appendChild(host);
  }, [renderPanel, dock, host, tutor.status]);

  useLayoutEffect(() => {
    document.body.toggleAttribute("data-tutor-open", tutor.open && dock && readerRoute && !isMobile);
    return () => document.body.removeAttribute("data-tutor-open");
  }, [tutor.open, dock, readerRoute, isMobile]);

  // epub.js sizes its iframe on window resize only; the drawer changes the page width.
  useEffect(() => {
    if (!readerRoute) return;
    const timer = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 140);
    return () => window.clearTimeout(timer);
  }, [tutor.open, readerRoute, isMobile]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]:not(#tutor-panel)')) return;
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.code === "KeyT" &&
        dock &&
        tutor.enabled
      ) {
        event.preventDefault();
        tutor.toggleTutor();
        return;
      }
      if (event.key !== "Escape" || !tutor.open || !dock) return;
      event.stopPropagation();
      tutor.closeTutor();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dock, tutor]);

  useEffect(() => {
    if (!tutor.open || !dock || tutor.view !== "chat") return;
    const frame = window.requestAnimationFrame(() => {
      const root = document.getElementById(DOCK_TARGET);
      root?.querySelector<HTMLTextAreaElement>(`[data-tutor-slot="${tutor.activeKey}"] textarea.asst-input`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tutor.open, tutor.activeKey, tutor.view, dock]);

  useEffect(() => {
    if (!modal) return;
    const main = document.getElementById("tutor-main");
    main?.setAttribute("inert", "");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const panel = document.getElementById("tutor-panel");
      if (!panel) return;
      const focusable = focusableIn(panel);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      main?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey, true);
    };
  }, [modal]);

  const showFab =
    tutor.enabled &&
    dock &&
    !modal &&
    !readerRoute &&
    (tutor.status ? tutor.status.scopes.library : true);

  return (
    <>
      {showFab && (
        <button
          ref={fab}
          type="button"
          className="tutor-fab"
          aria-expanded={tutor.open}
          aria-controls={renderPanel ? "tutor-panel" : undefined}
          aria-keyshortcuts="Alt+T"
          aria-label={tutor.open ? "Hide tutor" : "Open tutor"}
          title="Tutor (Alt+T)"
          onClick={tutor.toggleTutor}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="M3 3.5h10v7.2H8.1L5.4 13v-2.3H3z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path d="M5.4 6.3h5.2M5.4 8.2h3.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
          <span>Tutor</span>
        </button>
      )}
      {modal && <div className="tutor-backdrop" aria-hidden="true" onClick={tutor.closeTutor} />}
      <div
        id={DOCK_TARGET}
        className="tutor-slot-dock"
        hidden={!dock || !tutor.open}
      />
      {renderPanel && createPortal(<TutorPanel isMobile={isMobile} />, host)}
    </>
  );
}
