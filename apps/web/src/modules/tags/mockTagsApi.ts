import type { Book, Tag, TagWithCount } from "../../types";
import { numericIdOf } from "../library/mockBooksQuery";

const BASE_CREATED_AT = 1_760_000_000_000;

/** Deterministic fixture tags shared by the dev mock and the component tests. */
export const SEED_TAGS: Tag[] = [
  { id: "tag-favorites", name: "Favorites", color: "blue", createdAt: BASE_CREATED_AT },
  { id: "tag-read-later", name: "Read later", color: "green", createdAt: BASE_CREATED_AT + 1 },
  { id: "tag-research", name: "Research", color: "amber", createdAt: BASE_CREATED_AT + 2 },
];

/** Stable stand-in for `book_tags`: three independent membership rules. */
export function seedTagIds(bookId: string): string[] {
  const value = numericIdOf(bookId);
  const ids: string[] = [];
  if (value % 3 === 0) ids.push("tag-favorites");
  if (value % 4 === 0) ids.push("tag-research");
  if (value % 5 === 0) ids.push("tag-read-later");
  return ids;
}

export function withSeedTags(books: Book[]): Book[] {
  return books.map((book) => (book.tagIds ? book : { ...book, tagIds: seedTagIds(book.id) }));
}

export function tagCounts(books: Book[], tags: Tag[]): TagWithCount[] {
  return [...tags]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tag) => ({
      ...tag,
      count: books.filter((book) => (book.tagIds ?? []).includes(tag.id)).length,
    }));
}

/** Same normalization as the server: NFKC + lower case, so renaming only the case is allowed. */
export function tagKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export function normalizeTagName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ");
}
