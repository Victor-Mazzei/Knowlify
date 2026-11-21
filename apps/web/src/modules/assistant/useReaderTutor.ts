import { useCallback, useMemo, useRef } from "react";
import type { Book } from "../../types";
import type { Selection } from "../notes/types";
import { bookSlotKey } from "./tutorTypes";
import { useRegisterTutorContext, useTutorOptional } from "./TutorContext";
import type { ChatStatus } from "./types";

/**
 * Connects the reader to the global tutor. The hook registers only what the book
 * scope accepts, keeps the visible-text getter current without re-registering on
 * every render, and returns the toolbar actions.
 */
export function useReaderTutor({
  book,
  selection,
  page,
  section,
  visibleText,
  status,
}: {
  book: Book;
  selection?: Selection;
  page?: number;
  section?: string;
  visibleText: () => string;
  status: ChatStatus | null;
}) {
  const tutor = useTutorOptional();
  const visibleTextRef = useRef(visibleText);
  visibleTextRef.current = visibleText;
  const context = useMemo(
    () => ({
      book: { id: book.id, title: book.title },
      selection,
      page,
      section,
      visibleText: () => visibleTextRef.current(),
    }),
    [book.id, book.title, selection, page, section],
  );
  const available = Boolean(tutor && status?.enabled && status.scopes.book && tutor.enabled);
  useRegisterTutorContext(available ? context : null);

  const openHere = Boolean(tutor?.open && tutor.activeKey === bookSlotKey(book.id));
  const toggle = useCallback(() => tutor?.toggleTutor(), [tutor]);
  const close = useCallback(() => tutor?.closeTutor(), [tutor]);
  const askAbout = useCallback(() => {
    if (!tutor || !selection) return;
    tutor.askAbout({
      text: selection.text,
      kind: "selection",
      ...(page ? { page } : {}),
      ...(section ? { section } : {}),
    });
  }, [tutor, selection, page, section]);

  return { open: Boolean(tutor?.open), available, openHere, toggle, close, askAbout };
}
