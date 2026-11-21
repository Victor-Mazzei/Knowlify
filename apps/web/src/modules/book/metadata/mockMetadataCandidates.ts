import type { MetadataCandidate } from "../types";

/** Two providers, two valid ISBN pairs and one description: enough to exercise the panel. */
export const MOCK_METADATA_CANDIDATES: MetadataCandidate[] = [
  {
    source: "googlebooks",
    id: "gb-quiet-library",
    title: "The Quiet Library",
    authors: ["Ada North"],
    description:
      "A measured study of the rooms readers keep returning to, and of the books that wait there. Plain text only: <b>markup</b> never reaches the browser.",
    isbn10: "0306406152",
    isbn13: "9780306406157",
    publisher: "North Press",
    year: 2005,
    language: "en",
    coverUrl: "https://books.google.com/books/content?id=quiet&printsec=frontcover",
    link: "https://books.google.com/books?id=quiet",
  },
  {
    source: "openlibrary",
    id: "ol-meditations",
    title: "The Quiet Library: A Reader's History",
    authors: ["Ada North", "B. Vale"],
    description: null,
    isbn10: "0140449132",
    isbn13: "9780140449136",
    publisher: "Open House",
    year: 1998,
    language: "en",
    coverUrl: "https://covers.openlibrary.org/b/id/240727-L.jpg?default=false",
    link: "https://openlibrary.org/works/OL1W",
  },
  {
    source: "googlebooks",
    id: "gb-silent-shelf",
    title: "The Silent Shelf",
    authors: ["Mira Costa"],
    description: "Essays on marginalia and the habits of rereading.",
    isbn10: null,
    isbn13: "9780261102217",
    publisher: null,
    year: 2012,
    language: "en",
    coverUrl: null,
    link: "https://books.google.com/books?id=silent",
  },
];
