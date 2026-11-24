import { useCallback, useEffect, useRef, useState } from "react";
import { ASK_LIBRARY_OFF, ASK_LIBRARY_ON, LibraryToggle } from "./LibraryToggle";
import { ModeSwitch } from "./ModeSwitch";
import { FirstUseHint } from "./FirstUseHint";
import { SessionLimitNotice } from "./SessionLimitNotice";
import { ConversationList } from "./ConversationList";
import type { ConversationSection } from "./ConversationList";
import { TutorChats } from "./TutorChats";
import { useTutor } from "./TutorProvider";
import type { TutorSlot } from "./TutorProvider";
import { useConversations } from "./useConversations";
import { useTutorConversationActions } from "./useTutorConversationActions";
import type { ConversationSummary } from "./types";
import { useMediaQuery } from "../../components/useMediaQuery";
import { isDesktopShell } from "../../services/desktop";
import { COMPACT_TUTOR_QUERY, DESKTOP_RESERVE_STYLE } from "./tutorLayout";
import "./sessions.css";

const slotTitle = (slot: TutorSlot | undefined) => {
  if (!slot) return "Whole library";
  if (slot.conversationTitle) return slot.conversationTitle;
  if (slot.kind === "library") return "Whole library";
  return slot.bookTitle || "Book conversation";
};

const contextLine = (slot: TutorSlot | undefined, reader: ReturnType<typeof useTutor>["reader"]) => {
  if (!slot) return "Across all your books";
  if (slot.kind === "library") return "Across all your books";
  const where = [reader?.page ? `p. ${reader.page}` : "", reader?.section ?? ""].filter(Boolean).join(" · ");
  const attached = slot.excerpt ? (slot.excerpt.kind === "selection" ? "Passage attached" : "Page text attached") : "";
  if (reader && reader.book.id === slot.bookId) return ["This book", where, attached].filter(Boolean).join(" · ");
  return attached ? `This book · ${attached}` : "This book";
};

/**
 * The tutor surface: a fixed drawer outside /ask and the full workspace on /ask.
 * The element and the slots below it never change identity across surfaces, so
 * moving between the drawer and the page does not remount a running conversation.
 */
export function TutorPanel({ isMobile = false }: { isMobile?: boolean }) {
  const tutor = useTutor();
  const page = tutor.surface === "page";
  // The desktop shell injects a fixed connection button at the bottom-right.
  const desktop = isDesktopShell();
  const slot = tutor.activeSlot;
  const status = tutor.status;
  const bookId = slot?.kind === "book" ? slot.bookId : tutor.reader?.book.id;
  const scopeReady = Boolean(status?.enabled);
  const bookList = useConversations({
    api: tutor.api,
    bookId,
    enabled: scopeReady && Boolean(bookId) && Boolean(status?.scopes.book),
    revision: tutor.revision,
  });
  const libraryList = useConversations({
    api: tutor.api,
    bookId: undefined,
    enabled: scopeReady && Boolean(status?.scopes.library),
    revision: tutor.revision,
  });
  const actions = useTutorConversationActions({ tutor, lists: [bookList, libraryList] });
  const [announcement, setAnnouncement] = useState("");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // The short-viewport sheet is a disclosure over the page, so the covered chat stays inert.
  const compactSessions = useMediaQuery(COMPACT_TUTOR_QUERY);
  const sessionsToggle = useRef<HTMLButtonElement>(null);
  const sessionsClose = useRef<HTMLButtonElement>(null);
  const previousMode = useRef(slot?.mode);
  const previousLibrary = useRef(slot?.useLibrary);

  const closeSessions = useCallback((returnFocus = true) => {
    setSessionsOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => sessionsToggle.current?.focus());
  }, []);

  useEffect(() => {
    if (!page) setSessionsOpen(false);
  }, [page]);

  useEffect(() => {
    if (!compactSessions) setSessionsOpen(false);
  }, [compactSessions]);

  // On the desktop, the injected connection button owns the bottom-right corner.
  // When the panel column has to scroll, start at its end so the composer and
  // Send are visible above the button; the header/mode stay reachable by scrolling up.
  useEffect(() => {
    if (!desktop) return;
    const panel = panelRef.current;
    if (!panel) return;
    const settle = () => {
      if (panel.scrollHeight > panel.clientHeight + 1) panel.scrollTop = panel.scrollHeight;
    };
    settle();
    const frame = window.requestAnimationFrame(settle);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(settle);
    observer?.observe(panel);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [desktop, page]);

  // The sheet is a disclosure, not a modal: Escape closes it and focus returns to the trigger.
  useEffect(() => {
    if (!sessionsOpen) return;
    const frame = window.requestAnimationFrame(() => sessionsClose.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[aria-modal="true"]:not(#tutor-panel)')) return;
      // Escape inside an inline editor cancels that edit, not the whole sheet.
      if (event.target instanceof Element && event.target.closest("[data-tutor-rename]")) return;
      event.stopPropagation();
      closeSessions();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [sessionsOpen, closeSessions]);

  const busyIds = new Set<string>();
  for (const item of tutor.slots) {
    if (!item.streaming) continue;
    if (item.conversationId) busyIds.add(item.conversationId);
    if (item.initialId) busyIds.add(item.initialId);
  }
  const deletingIds = new Set([...bookList.deletingIds, ...libraryList.deletingIds]);
  if (actions.busy && slot?.conversationId) deletingIds.add(slot.conversationId);
  for (const id of deletingIds) busyIds.add(id);
  const activeId = slot?.conversationId ?? slot?.initialId;
  const errors = [bookList.error, libraryList.error, actions.error].filter(
    (message, index, all) => Boolean(message) && all.indexOf(message) === index,
  );
  const sections: ConversationSection[] = [
    ...(bookId ? [{ id: "book" as const, label: "This book", conversations: bookList.conversations }] : []),
    { id: "library", label: "Whole library", conversations: libraryList.conversations },
  ];
  const limits = status?.sessionLimits;
  const counts = tutor.sessionLimit ?? (limits ? { limit: limits.maxSessions, count: limits.count } : null);

  useEffect(() => {
    if (tutor.view === "sessions") {
      void bookList.refresh();
      void libraryList.refresh();
    }
    // `refresh` is stable for one scope; the view change is what triggers the read.
  }, [tutor.view, bookList.refresh, libraryList.refresh]);

  // Announce a mode change in a polite region, including the session name.
  useEffect(() => {
    if (!slot) return;
    if (previousMode.current === slot.mode) return;
    previousMode.current = slot.mode;
    setAnnouncement(
      slot.mode === "ask"
        ? "Ask mode. Nothing is saved."
        : `Session mode. Saved as ${slot.conversationTitle ?? "a new session"}.`,
    );
  }, [slot]);

  // Announce the library switch state, which is the other visible privacy choice.
  useEffect(() => {
    if (!slot) return;
    if (slot.mode !== "ask") {
      previousLibrary.current = slot.useLibrary;
      return;
    }
    if (previousLibrary.current === slot.useLibrary) return;
    previousLibrary.current = slot.useLibrary;
    setAnnouncement(slot.useLibrary ? ASK_LIBRARY_ON : ASK_LIBRARY_OFF);
  }, [slot]);

  // Focus returns to the question field after the panel remounts for the new mode.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>(`[data-tutor-slot="${tutor.activeKey}"] textarea.asst-input`)
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [slot?.mode, tutor.activeKey]);

  const rename = async (conversation: ConversationSummary, title: string) => {
    const list = conversation.scope.kind === "book" ? bookList : libraryList;
    const ok = await list.rename(conversation.id, title);
    if (ok) tutor.renameConversation(conversation.id, title);
    return ok;
  };

  /** Picking a session from the compact sheet returns to the chat and keeps focus predictable. */
  const selectSession = (conversation: ConversationSummary) => {
    const fromSheet = sessionsOpen;
    setSessionsOpen(false);
    tutor.selectConversation(conversation);
    if (fromSheet) window.requestAnimationFrame(() => sessionsToggle.current?.focus());
  };

  const startNewFromList = () => {
    const fromSheet = sessionsOpen;
    setSessionsOpen(false);
    actions.startNew();
    if (fromSheet) window.requestAnimationFrame(() => sessionsToggle.current?.focus());
  };

  const newTitle = slot?.streaming
    ? "Available when the answer finishes."
    : actions.busy
      ? "Deleting this conversation…"
      : undefined;

  const modeBar = status?.enabled && tutor.modesSupported && slot && (
    <div className="tutor-mode-bar">
      <ModeSwitch value={slot.mode} onChange={tutor.setChatMode} disabled={slot.streaming} />
      {slot.mode === "ask" && (
        <LibraryToggle
          checked={slot.useLibrary}
          onChange={(value) => tutor.setSlotUseLibrary(slot.key, value)}
          disabled={slot.streaming}
          libraryAvailable={Boolean(status.scopes.library)}
          hasExcerpt={Boolean(slot.excerpt)}
        />
      )}
      <FirstUseHint />
    </div>
  );

  const listView = (
    <div className="tutor-sessions">
      {errors.map((message) => (
        <p key={message} className="error asst-rail-error" role="alert">
          {message}
        </p>
      ))}
      {tutor.sessionLimit && (
        <SessionLimitNotice limit={tutor.sessionLimit.limit} count={tutor.sessionLimit.count} />
      )}
      <ConversationList
        sections={sections}
        activeId={activeId}
        deleteDisabledIds={busyIds}
        onSelect={selectSession}
        onDelete={(conversation) => void actions.removeConversation(conversation)}
        onRename={rename}
      />
      {counts && (
        <p className="tutor-session-count">
          {counts.count} of {counts.limit} sessions saved on this server.
        </p>
      )}
    </div>
  );

  return (
    <div
      ref={panelRef}
      id="tutor-panel"
      data-desktop={desktop ? "true" : undefined}
      data-sessions-open={page && sessionsOpen ? "true" : undefined}
      className={page ? "asst-page tutor-page" : "tutor-dock"}
      style={desktop ? DESKTOP_RESERVE_STYLE : undefined}
      role={page ? undefined : isMobile ? "dialog" : "complementary"}
      aria-modal={!page && isMobile ? true : undefined}
      aria-label={page ? undefined : "Tutor"}
    >
      {page && sessionsOpen && (
        <div className="tutor-sessions-backdrop" aria-hidden="true" onClick={() => closeSessions()} />
      )}
      {page && (
        <aside id="tutor-sessions" className="asst-rail" aria-label="Sessions">
          <div className="asst-rail-head">
            <p className="eyebrow">Sessions</p>
            <button
              ref={actions.newButtonRef}
              type="button"
              className="ghost bordered"
              onClick={startNewFromList}
              disabled={actions.newDisabled}
            >
              New session
            </button>
            {sessionsOpen && (
              <button
                ref={sessionsClose}
                type="button"
                className="tutor-sessions-close"
                aria-label="Close sessions"
                onClick={() => closeSessions()}
              >
                ×
              </button>
            )}
          </div>
          {listView}
        </aside>
      )}

      <section
        className={page ? "asst-main" : "tutor-main"}
        aria-label={page ? "Chat" : undefined}
        inert={page && sessionsOpen && compactSessions ? true : undefined}
      >
        {page ? (
          <header className="asst-heading">
            <p className="eyebrow">Tutor</p>
            <h1>Ask your library</h1>
            <p>
              {tutor.modesSupported
                ? "Ask a quick question, or keep a saved session."
                : "Keep a saved session with your books."}
            </p>
            <button
              ref={sessionsToggle}
              type="button"
              className="ghost bordered tutor-sessions-toggle"
              aria-expanded={sessionsOpen}
              aria-controls="tutor-sessions"
              onClick={() => setSessionsOpen((open) => !open)}
            >
              Sessions
            </button>
          </header>
        ) : (
          <header className="tutor-head">
            <div className="tutor-heading">
              <p className="eyebrow">Tutor</p>
              <h2 id="tutor-title">{slotTitle(slot)}</h2>
              <p className="tutor-context">{contextLine(slot, tutor.reader)}</p>
            </div>
            <div className="tutor-head-actions">
              <button
                ref={actions.newButtonRef}
                type="button"
                className="ghost bordered tutor-new"
                onClick={() => actions.startNew()}
                disabled={actions.newDisabled}
                title={newTitle}
              >
                New session
              </button>
              <button
                type="button"
                className="close"
                aria-label="Close tutor"
                title="Close (Esc)"
                onClick={tutor.closeTutor}
              >
                ×
              </button>
            </div>
          </header>
        )}

        {modeBar}
        <p className="asst-visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>

        {!page && (
          <div className="tutor-controls">
            {tutor.reader && status?.scopes.book && (
              <div className="tutor-modes" role="group" aria-label="Chat scope">
                <button
                  type="button"
                  aria-pressed={slot?.kind === "book"}
                  onClick={() => tutor.setMode("book")}
                >
                  This book
                </button>
                <button
                  type="button"
                  aria-pressed={slot?.kind === "library"}
                  disabled={!status.scopes.library}
                  title={
                    status.scopes.library
                      ? undefined
                      : "Turn on the search index in Settings to ask across your library."
                  }
                  onClick={() => tutor.setMode("library")}
                >
                  Whole library
                </button>
              </div>
            )}
            <div className="tutor-views" role="group" aria-label="Tutor view">
              <button
                type="button"
                aria-pressed={tutor.view === "chat"}
                onClick={() => tutor.setView("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                aria-pressed={tutor.view === "sessions"}
                onClick={() => tutor.setView("sessions")}
              >
                Sessions
              </button>
            </div>
          </div>
        )}

        {!page && tutor.view === "chat" &&
          errors.map((message) => (
            <p key={message} className="error tutor-error" role="alert">
              {message}
            </p>
          ))}

        {!page && tutor.view === "sessions" && (
          <div className="tutor-history">
            <p className="tutor-history-head">
              <span className="eyebrow">Sessions</span>
              <span className="muted">
                {bookList.loading || libraryList.loading
                  ? "Loading…"
                  : `${bookList.conversations.length + libraryList.conversations.length} saved`}
              </span>
            </p>
            {listView}
          </div>
        )}

        <TutorChats
          hidden={!page && tutor.view !== "chat"}
          disabledConversationIds={deletingIds}
        />
      </section>
      {actions.dialog}
    </div>
  );
}
