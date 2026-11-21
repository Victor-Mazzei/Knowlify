import { useEffect } from "react";
import { ConversationList } from "./ConversationList";
import { TutorChats } from "./TutorChats";
import { useTutor } from "./TutorProvider";
import type { TutorSlot } from "./TutorProvider";
import { useConversations } from "./useConversations";
import { useTutorConversationActions } from "./useTutorConversationActions";

const slotTitle = (slot: TutorSlot | undefined) => {
  if (!slot || slot.kind === "library") return "Whole library";
  return slot.bookTitle || slot.conversationTitle || "Book conversation";
};

const contextLine = (slot: TutorSlot | undefined, reader: ReturnType<typeof useTutor>["reader"]) => {
  if (!slot || slot.kind === "library") return "Across all your books";
  const where = [reader?.page ? `p. ${reader.page}` : "", reader?.section ?? ""].filter(Boolean).join(" · ");
  const attached = slot.excerpt ? (slot.excerpt.kind === "selection" ? "Passage attached" : "Page text attached") : "";
  if (reader && reader.book.id === slot.bookId) return [where, attached].filter(Boolean).join(" · ") || "This book";
  return attached || "Book conversation";
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
  const bookId = slot?.kind === "book" ? slot.bookId : undefined;
  const scopeReady = Boolean(
    tutor.status?.enabled && (bookId ? tutor.status.scopes.book : tutor.status.scopes.library),
  );
  const list = useConversations({
    api: tutor.api,
    bookId,
    enabled: scopeReady,
    revision: tutor.revision,
  });
  const actions = useTutorConversationActions({ tutor, list });
  const busyIds = new Set<string>();
  for (const item of tutor.slots) {
    if (!item.streaming) continue;
    if (item.conversationId) busyIds.add(item.conversationId);
    if (item.initialId) busyIds.add(item.initialId);
  }
  const deletingIds = new Set(list.deletingIds);
  if (actions.busy && slot?.conversationId) deletingIds.add(slot.conversationId);
  for (const id of deletingIds) busyIds.add(id);
  const activeId = slot?.conversationId ?? slot?.initialId;
  const errors = [list.error, actions.error].filter(Boolean);

  useEffect(() => {
    if (tutor.view === "history") void list.refresh();
    // `refresh` is stable for one scope; the view change is what triggers the read.
  }, [tutor.view, list.refresh]);

  const startNew = () => {
    if (!actions.newDisabled) void actions.startNew();
  };
  const newTitle = slot?.streaming
    ? "Available when the answer finishes."
    : actions.busy
      ? "Deleting this conversation…"
      : undefined;

  return (
    <div
      id="tutor-panel"
      className={page ? "asst-page tutor-page" : "tutor-dock"}
      role={page ? undefined : isMobile ? "dialog" : "complementary"}
      aria-modal={!page && isMobile ? true : undefined}
      aria-label={page ? undefined : "Tutor"}
    >
      {page && (
        <aside className="asst-rail" aria-label="Conversations">
          <div className="asst-rail-head">
            <p className="eyebrow">Conversations</p>
            <button
              ref={actions.newButtonRef}
              type="button"
              className="ghost bordered"
              onClick={startNew}
              disabled={actions.newDisabled}
            >
              New
            </button>
          </div>
          {errors.map((message) => (
            <p key={message} className="error asst-rail-error" role="alert">
              {message}
            </p>
          ))}
          <ConversationList
            conversations={list.conversations}
            activeId={activeId}
            deleteDisabledIds={busyIds}
            onSelect={tutor.selectConversation}
            onDelete={(conversation) => void actions.removeConversation(conversation)}
          />
        </aside>
      )}

      <section className={page ? "asst-main" : "tutor-main"} aria-label={page ? "Chat" : undefined}>
        {page ? (
          <header className="asst-heading">
            <p className="eyebrow">Tutor</p>
            <h1>Ask your library</h1>
            <p>Answers are grounded in your books and cite the passages they use.</p>
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
                onClick={startNew}
                disabled={actions.newDisabled}
                title={newTitle}
              >
                New chat
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

        {!page && (
          <div className="tutor-controls">
            {tutor.reader && tutor.status?.scopes.book && (
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
                  disabled={!tutor.status.scopes.library}
                  title={
                    tutor.status.scopes.library
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
                aria-pressed={tutor.view === "history"}
                onClick={() => tutor.setView("history")}
              >
                History
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

        {!page && tutor.view === "history" && (
          <div className="tutor-history">
            <p className="tutor-history-head">
              <span className="eyebrow">Recent conversations</span>
              <span className="muted">{list.loading ? "Loading…" : `${list.conversations.length} saved`}</span>
            </p>
            {errors.map((message) => (
              <p key={message} className="error asst-rail-error" role="alert">
                {message}
              </p>
            ))}
            <ConversationList
              conversations={list.conversations}
              activeId={activeId}
              deleteDisabledIds={busyIds}
              onSelect={tutor.selectConversation}
              onDelete={(conversation) => void actions.removeConversation(conversation)}
            />
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
