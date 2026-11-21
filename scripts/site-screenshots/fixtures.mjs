#!/usr/bin/env node
/**
 * Seed a disposable Knowlify instance for the public screenshots.
 *
 * Usage:
 *   KNOWLIFY_BASE_URL=http://127.0.0.1:8787 \
 *   KNOWLIFY_USER=admin KNOWLIFY_PASSWORD=... \
 *   node scripts/site-screenshots/fixtures.mjs
 *
 * The script is idempotent enough for a fresh data directory: it waits for the
 * scanned books, then creates tags, favorites, reading progress and notes.
 * It refuses to run when the library does not look like the fixture library.
 */
const BASE = (process.env.KNOWLIFY_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const USER = process.env.KNOWLIFY_USER ?? "admin";
const PASS = process.env.KNOWLIFY_PASSWORD ?? "demo-library-pass";
const EXPECTED_BOOKS = Number(process.env.KNOWLIFY_EXPECTED_BOOKS ?? 18);

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: auth, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") ?? "";
  return type.includes("json") ? response.json() : response.text();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBooks() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const page = await api("/api/books?limit=200&sort=title");
    if (page.total >= EXPECTED_BOOKS) return page.items;
    await sleep(1000);
  }
  throw new Error(`Library did not reach ${EXPECTED_BOOKS} books`);
}

async function waitForIndex() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = await api("/api/index/status");
    if (status.counts.ready >= EXPECTED_BOOKS && status.counts.pending === 0 && status.counts.indexing === 0) {
      return status;
    }
    await sleep(1000);
  }
  throw new Error("Index did not finish");
}

const byTitle = (books, title) => {
  const book = books.find((candidate) => candidate.title === title);
  if (!book) throw new Error(`Book not found: ${title}`);
  return book;
};

const books = await waitForBooks();
if (books.length !== EXPECTED_BOOKS) {
  throw new Error(`Expected ${EXPECTED_BOOKS} books, found ${books.length}. Use a fresh data directory.`);
}

const title = (name) => byTitle(books, name);

const tagSpecs = [
  { name: "Classics", color: "green" },
  { name: "Philosophy", color: "amber" },
  { name: "Science fiction", color: "violet" },
  { name: "To reread", color: "blue" },
  { name: "Gothic", color: "red" },
];

const existing = await api("/api/tags");
const tagsByName = new Map(existing.items.map((tag) => [tag.name, tag]));
for (const spec of tagSpecs) {
  if (tagsByName.has(spec.name)) continue;
  const tag = await api("/api/tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
  tagsByName.set(tag.name, tag);
}

async function addTags(bookTitles, tagNames) {
  const ids = bookTitles.map((name) => title(name).id);
  const add = tagNames.map((name) => tagsByName.get(name).id);
  await api("/api/books/tags", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selection: { ids }, add }),
  });
}

await addTags(
  [
    "Pride and Prejudice",
    "Moby Dick",
    "Anna Karenina",
    "Great Expectations",
    "A Tale of Two Cities",
    "The Scarlet Letter",
    "The Adventures of Huckleberry Finn",
    "Around the World in Eighty Days",
  ],
  ["Classics"],
);
await addTags(["Meditations", "The Art of War"], ["Philosophy", "Classics"]);
await addTags(["The Time Machine", "The War of the Worlds"], ["Science fiction", "To reread"]);
await addTags(["Frankenstein", "Dracula", "The Picture of Dorian Gray"], ["Gothic"]);
await addTags(["Moby Dick", "Anna Karenina"], ["To reread"]);
await addTags(["Alice’s Adventures in Wonderland"], ["Classics"]);

const favoriteTitles = [
  "Pride and Prejudice",
  "Moby Dick",
  "Alice’s Adventures in Wonderland",
  "Meditations",
  "The Picture of Dorian Gray",
  "The Art of War",
];
for (const name of favoriteTitles) {
  await api(`/api/books/${title(name).id}/favorite`, { method: "PUT" });
}

const progress = [
  ["Pride and Prejudice", 0.08, ""],
  ["Moby Dick", 0.18, ""],
  ["Frankenstein", 0.67, ""],
  ["The Art of War", 1, ""],
  ["Alice’s Adventures in Wonderland", 0.08, ""],
];
for (const [name, percentage, position] of progress) {
  await api(`/api/books/${title(name).id}/progress`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ position, percentage }),
  });
}

const notes = [
  {
    book: "Pride and Prejudice",
    label: "Volume I, Chapter 34",
    quote: "In vain have I struggled. It will not do. My feelings will not be repressed.",
    body: "Darcy describes love as a struggle he has lost, not a choice he has made. His proposal is honest and still fails because he never asks what Elizabeth wants.",
  },
  {
    book: "Pride and Prejudice",
    label: "Volume II, Chapter 10",
    quote: "There is a stubbornness about me that never can bear to be frightened at the will of others.",
    body: "Elizabeth's wit is not only decoration. It is how she keeps her judgment when the people around her expect her to submit.",
  },
  {
    book: "Pride and Prejudice",
    label: "Volume III, Chapter 1",
    quote: "Think only of the past as its remembrance gives you pleasure.",
    body: "The narrator's free indirect style lets the reader hear Elizabeth's relief and her embarrassment at the same time.",
  },
  {
    book: "Moby Dick",
    label: "Chapter 1, Loomings",
    quote: "Call me Ishmael.",
    body: "The book begins with a name that may not be a name. That uncertainty sets the tone for every fact that follows.",
  },
  {
    book: "Moby Dick",
    label: "Chapter 36, The Quarter-Deck",
    quote: "All visible objects, man, are but as pasteboard masks.",
    body: "Ahab turns a private grievance into a theory of the world. The whale becomes less an animal than a surface he needs to strike through.",
  },
  {
    book: "Meditations",
    label: "Book II",
    quote: "You have power over your mind - not outside events. Realize this, and you will find strength.",
    body: "The advice is practical but not easy. Marcus keeps returning to the gap between what happens and what we decide it means.",
  },
  {
    book: "Meditations",
    label: "Book IV",
    quote: "The happiness of your life depends upon the quality of your thoughts.",
    body: "A useful sentence to test against the rest of the book. The point is not positive thinking but disciplined attention.",
  },
  {
    book: "Frankenstein",
    label: "Volume II, Chapter 8",
    quote: "I was benevolent and good; misery made me a fiend.",
    body: "The creature's argument is that cruelty is made, not born. Shelley lets him make it in his own voice, which is what makes the novel uncomfortable.",
  },
  {
    book: "Frankenstein",
    label: "Volume III, Chapter 7",
    quote: "I have love in me the likes of which you can scarcely imagine and rage the likes of which you would not believe.",
    body: "Love and rage are not opposites here. They come from the same demand to be recognized.",
  },
  {
    book: "The Picture of Dorian Gray",
    label: "Chapter 2",
    quote: "The only way to get rid of a temptation is to yield to it.",
    body: "Wilde gives the worst advice in the book to the most charming character. The reader has to decide whether the wit is a warning or an invitation.",
  },
  {
    book: "The Picture of Dorian Gray",
    label: "Chapter 20",
    quote: "All art is quite useless.",
    body: "The preface is a set of claims that the novel then tests. Dorian's life becomes a work of art, and that is precisely the problem.",
  },
  {
    book: "Alice’s Adventures in Wonderland",
    label: "Chapter 6, Pig and Pepper",
    quote: "We're all mad here. I'm mad. You're mad.",
    body: "The Cheshire Cat states the rules of the place as if they were obvious. Alice keeps trying to apply ordinary logic to a world that has none.",
  },
];

for (const note of notes) {
  await api(`/api/books/${title(note.book).id}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: note.label,
      quote: note.quote,
      body: note.body,
      location: note.label,
    }),
  });
}

const index = await waitForIndex();
console.log(
  JSON.stringify({
    books: books.length,
    tags: tagsByName.size,
    favorites: favoriteTitles.length,
    progress: progress.length,
    notes: notes.length,
    index: index.counts,
  }),
);
