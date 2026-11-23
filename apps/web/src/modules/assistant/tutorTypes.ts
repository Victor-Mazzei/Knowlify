import type { Selection } from "../notes/types";
import type { ChatExcerpt } from "./excerpt";
import type { ChatMode } from "./types";

const MAX_BOOK_SLOTS = 3;
export const LIBRARY_SLOT_KEY = "library";
export const bookSlotKey = (bookId: string) => `book:${bookId}`;

/** The book context the reader shares with the tutor; only what the API accepts. */
export type TutorReaderContext = {
  book: { id: string; title: string };
  selection?: Selection;
  page?: number;
  section?: string;
  visibleText?: () => string;
};

/** One independent conversation slot. A conversation scope never changes, so slots never share one. */
export type TutorSlot = {
  key: string;
  kind: "library" | "book";
  bookId?: string;
  bookTitle?: string;
  /** Ask answers are ephemeral; Session answers are saved. */
  mode: ChatMode;
  /** Ask only: the library switch for the next question. */
  useLibrary: boolean;
  conversationId?: string;
  conversationTitle?: string;
  /** Conversation the panel must load when it (re)mounts. */
  initialId?: string;
  /** Incremented to remount the panel: new session, mode change or a conversation picked from history. */
  session: number;
  streaming: boolean;
  excerpt?: ChatExcerpt;
  excerptError?: string;
  /** The one automatic "latest session of this book" lookup already ran. */
  resumeChecked?: boolean;
  /** Title of the session the panel loaded automatically, for the "Resuming" banner. */
  resumedTitle?: string;
};

export type TutorSurface = "dock" | "page";
export type TutorView = "chat" | "sessions";

export const newSlot = (
  kind: "library" | "book",
  book: { id: string; title: string } | undefined,
  defaults: { mode: ChatMode; useLibrary: boolean },
): TutorSlot => ({
  key: kind === "library" ? LIBRARY_SLOT_KEY : bookSlotKey(book?.id ?? ""),
  kind,
  ...(kind === "book" ? { bookId: book?.id, bookTitle: book?.title } : {}),
  mode: defaults.mode,
  useLibrary: defaults.useLibrary,
  session: 0,
  streaming: false,
});

/** Drops the least recently used book slots, never one that is answering or on screen. */
export function pruneSlots(slots: TutorSlot[], activeKey: string, protectedKey?: string): TutorSlot[] {
  const books = slots.filter((slot) => slot.kind === "book");
  if (books.length <= MAX_BOOK_SLOTS) return slots;
  const removable = books
    .filter((slot) => !slot.streaming && slot.key !== activeKey && slot.key !== protectedKey)
    .slice(0, books.length - MAX_BOOK_SLOTS);
  if (removable.length === 0) return slots;
  const drop = new Set(removable.map((slot) => slot.key));
  return slots.filter((slot) => !drop.has(slot.key));
}

export const moveToEnd = (slots: TutorSlot[], key: string) => {
  const index = slots.findIndex((slot) => slot.key === key);
  if (index < 0 || index === slots.length - 1) return slots;
  const next = [...slots];
  const [slot] = next.splice(index, 1);
  if (slot) next.push(slot);
  return next;
};
