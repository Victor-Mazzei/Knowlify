import { useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { Book, Progress } from "../../types";
import { chatApi } from "../assistant/chatApi";
import { useReaderTutor } from "../assistant/useReaderTutor";
import { useChatStatus, useChatStatusContextOptional } from "../assistant/useChatStatus";
import { NotesPanel } from "../notes/NotesPanel";
import type { Note, Selection } from "../notes/types";
import { ProgressBar } from "../library/ProgressBar";
import { PageControl } from "./PageControl";
import { useEpubReader } from "./useEpubReader";
import { usePdfReader } from "./usePdfReader";
import { useReadingProgress } from "./useReadingProgress";
import { newsQueryFromTitle } from "../news/query";

export function ReaderBody({
  book,
  data,
  progress,
  jump,
  api,
  onNewsAbout,
}: {
  book: Book;
  data: ArrayBuffer;
  progress: Progress;
  jump: string;
  api: ApiFn;
  onNewsAbout?: (text: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>();
  const [flash, setFlash] = useState("");
  const { scheduleProgress, flushProgress, latestProgress, percentage } = useReadingProgress(api, book.id, progress);
  const assistantApi = chatApi(api);
  const workspaceChat = useChatStatusContextOptional();
  // The signed-in provider already knows the status; probing again would make the
  // reader toolbar grow on its own, after the first paint.
  const ownChat = useChatStatus(assistantApi, workspaceChat === null);
  const chatStatus = (workspaceChat ?? ownChat).status;
  const { page, setPage, numPages, visibleText: pdfVisibleText } = usePdfReader({
    book,
    data,
    container,
    initialPosition: jump || progress.position,
    scheduleProgress,
    onError: setError,
  });
  const {
    epubReady,
    epubPage,
    goToPage,
    step: stepEpub,
    currentCfi,
    displayLocation,
    visibleText: epubVisibleText,
    currentSection,
  } = useEpubReader({
    book,
    data,
    container,
    initialPosition: jump || progress.position,
    notes,
    scheduleProgress,
    flushProgress,
    latestProgress,
    onError: setError,
    onSelection: setSelection,
  });

  useEffect(() => {
    let cancelled = false;
    api(`/api/books/${book.id}/notes`)
      .then((response) => response.json())
      .then((list: Note[]) => !cancelled && setNotes(list))
      .catch(() => {
        // Notes are secondary: a failed load must not keep the book from opening.
      });
    return () => {
      cancelled = true;
    };
  }, [api, book.id]);

  useEffect(() => () => flushProgress(), [flushProgress]);

  const where = book.format === "pdf" ? `page ${page}` : epubPage.total ? `page ${epubPage.page}` : "this position";
  const currentLocation = () => (book.format === "pdf" ? String(page) : currentCfi());
  const pageNumber = book.format === "pdf" ? page : epubPage.total ? epubPage.page : undefined;
  const visibleText = book.format === "pdf" ? pdfVisibleText : epubVisibleText;
  const sectionName = book.format === "epub" ? currentSection?.() : "";

  // Citation links use ?at=<page>; EPUB resolves a numeric target once its page map exists.
  const jumpPage = book.format === "epub" && /^\d+$/.test(jump) ? Number(jump) : 0;
  const jumpApplied = useRef(false);
  useEffect(() => {
    if (!jumpPage || jumpApplied.current || !epubReady || !epubPage.total) return;
    jumpApplied.current = true;
    goToPage(jumpPage);
  }, [epubReady, epubPage.total, goToPage, jumpPage]);

  const tutor = useReaderTutor({
    book,
    selection,
    page: pageNumber,
    section: sectionName || undefined,
    visibleText,
    status: chatStatus,
  });

  // The drawer's fixed width and the notes panel would leave too little page.
  useEffect(() => {
    if (tutor.open) setNotesOpen(false);
  }, [tutor.open]);

  async function addNote(body: string) {
    const location = selection?.location || currentLocation();
    try {
      const response = await api(`/api/books/${book.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          quote: selection?.text ?? "",
          location,
          label: where.charAt(0).toUpperCase() + where.slice(1),
        }),
      });
      const created: Note = await response.json();
      setNotes((current) => [created, ...current]);
      setSelection(undefined);
    } catch (e) {
      setFlash(formatError(e));
      throw e;
    }
  }

  async function updateNote(note: Note, body: string) {
    const response = await api(`/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const updated: Note = await response.json();
    setNotes((current) => current.map((item) => (item.id === note.id ? updated : item)));
  }

  async function deleteNote(note: Note) {
    await api(`/api/notes/${note.id}`, { method: "DELETE" });
    setNotes((current) => current.filter((item) => item.id !== note.id));
  }

  const step = (delta: 1 | -1) => {
    if (book.format === "pdf") setPage((current) => Math.min(numPages ?? 1, Math.max(1, current + delta)));
    else stepEpub(delta);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") stepRef.current(1);
      else if (event.key === "ArrowLeft" || event.key === "PageUp") stepRef.current(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function jumpTo(note: Note) {
    if (!note.location) return;
    if (book.format === "pdf") setPage(Math.max(1, Number(note.location) || 1));
    else if (!displayLocation(note.location)) setFlash("That position is no longer available in this book.");
  }

  if (error)
    return (
      <div className="reader-message error" role="alert">
        {error}
      </div>
    );
  const total = book.format === "pdf" ? numPages ?? 0 : epubPage.total;
  return (
    <div className={`reader-layout ${notesOpen ? "with-notes" : ""}`}>
      <div className="reader-main">
        <div className="reader-toolbar">
          <div>
            <span className="format">{book.format}</span>
            <strong>{book.title}</strong>
            <ProgressBar percentage={percentage} />
          </div>
          <div className="reader-tools">
            {total > 0 ? (
              <PageControl
                page={book.format === "pdf" ? page : epubPage.page}
                total={total}
                onChange={(n) => (book.format === "pdf" ? setPage(n) : goToPage(n))}
                onStep={step}
              />
            ) : book.format === "epub" ? (
              <div className="pager">
                <button aria-label="Previous page" onClick={() => step(-1)}>
                  ←
                </button>
                <span className="muted">{epubReady ? "Counting pages…" : "Loading book…"}</span>
                <button aria-label="Next page" onClick={() => step(1)}>
                  →
                </button>
              </div>
            ) : null}
            {onNewsAbout && (
              <button className="ghost" onClick={() => onNewsAbout(newsQueryFromTitle(book.title))}>
                News about this
              </button>
            )}
            {tutor.available && selection && (
              <button
                className="ghost"
                onClick={tutor.askAbout}
              >
                Ask about this
              </button>
            )}
            {tutor.available && (
              <button
                id="tutor-reader-toggle"
                className={`ghost notes-toggle ${tutor.openHere ? "active" : ""}`}
                aria-pressed={tutor.openHere}
                onClick={() => {
                  setNotesOpen(false);
                  tutor.toggle();
                }}
              >
                Tutor
              </button>
            )}
            <button
              className={`ghost notes-toggle ${notesOpen ? "active" : ""}`}
              aria-pressed={notesOpen}
              onClick={() => {
                setNotesOpen((open) => !open);
                tutor.close();
              }}
            >
              Notes{notes.length ? ` · ${notes.length}` : ""}
            </button>
          </div>
        </div>
        {flash && (
          <div className="error" role="alert">
            {flash}
          </div>
        )}
        <div className={`reader-page ${book.format}`} ref={container} />
      </div>
      {notesOpen && (
        <NotesPanel
          notes={notes}
          selection={selection}
          where={where}
          onClose={() => setNotesOpen(false)}
          onClearSelection={() => setSelection(undefined)}
          onAdd={addNote}
          onUpdate={updateNote}
          onDelete={deleteNote}
          onJump={jumpTo}
          onNewsAbout={onNewsAbout}
        />
      )}
    </div>
  );
}
