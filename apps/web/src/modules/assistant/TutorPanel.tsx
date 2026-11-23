import { useEffect, useRef, useState } from "react";
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
  const previousMode = useRef(slot?.mode);
  const previousLibrary = useRef(slot?.useLibrary);

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
        onSelect={tutor.selectConversation}
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
      id="tutor-panel"
      className={page ? "asst-page tutor-page" : "tutor-dock"}
      role={page ? undefined : isMobile ? "dialog" : "complementary"}
      aria-modal={!page && isMobile ? true : undefined}
      aria-label={page ? undefined : "Tutor"}
    >
      {page && (
        <aside className="asst-rail" aria-label="Sessions">
          <div className="asst-rail-head">
            <p className="eyebrow">Sessions</p>
            <button
              ref={actions.newButtonRef}
              type="button"
              className="ghost bordered"
              onClick={() => actions.startNew()}
              disabled={actions.newDisabled}
            >
              New session
            </button>
          </div>
          {listView}
        </aside>
      )}

      <section className={page ? "asst-main" : "tutor-main"} aria-label={page ? "Chat" : undefined}>
        {page ? (
          <header className="asst-heading">
            <p className="eyebrow">Tutor</p>
            <h1>Ask your library</h1>
            <p>
              {tutor.modesSupported
                ? "Ask a quick question, or keep a session with your books. Answers cite the passages they use when the library is on."
                : "Keep a session with your books. Answers cite the passages they use when the library is on."}
            </p>
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
