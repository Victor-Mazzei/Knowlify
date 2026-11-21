export type Note = {
  id: string;
  bookId: string;
  bookTitle?: string;
  location: string;
  label: string;
  quote: string;
  body: string;
  createdAt: number;
  updatedAt: number;
};

/** The book projection returned by `GET /api/notes/groups`. */
export type NoteBook = {
  id: string;
  title: string;
  author: string | null;
  format: "pdf" | "epub";
  hasCover: boolean;
};

export type NoteGroup = {
  book: NoteBook;
  noteCount: number;
  lastNoteAt: number;
  notes: Note[];
  hasMore: boolean;
};

export type NoteGroupsPage = {
  items: NoteGroup[];
  nextCursor: string | null;
  totalBooks: number;
  totalNotes: number;
};

/** First load either groups by book or, on an older server, the legacy flat list. */
export type NoteFeed =
  | { mode: "groups"; page: NoteGroupsPage }
  | { mode: "legacy"; notes: Note[] };

export type NoteGroupStatus = { loading: boolean; error: string };

export type Selection = { location: string; text: string };
