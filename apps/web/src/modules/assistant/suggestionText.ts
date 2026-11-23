import type { RecommendedBook } from "./types";

const SHORT_TITLE_LENGTH = 44;

/** One-line title for an inline chip; the full title stays in the link's title/aria-label. */
export function shortBookTitle(title: string, maxLength = SHORT_TITLE_LENGTH): string {
  const text = title.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/** The one accessible name used by every link to a suggested book. */
export function bookOpenLabel(book: Pick<RecommendedBook, "title" | "author">): string {
  const author = book.author.trim();
  return author ? `Open ${book.title} by ${author}` : `Open ${book.title}`;
}

/** Reading state as text, never color alone. */
export function readingLabel(progress: RecommendedBook["progress"]): string {
  if (progress.status === "finished") return "Finished";
  if (progress.status === "unread") return "Not read";
  const percentage = Number.isFinite(progress.percentage) ? progress.percentage : 0;
  const percent = Math.min(99, Math.max(1, Math.round(percentage * 100)));
  return `In progress ${percent}%`;
}

/** Why the card is here: matched question terms and passages, or metadata-only. */
export function matchesLabel(book: RecommendedBook): string {
  if (book.source === "metadata") return "Matches the title";
  const passages = `${book.evidence.length} ${book.evidence.length === 1 ? "passage" : "passages"}`;
  const terms = book.matched.filter(Boolean);
  return terms.length > 0 ? `Matches: ${terms.join(", ")} · ${passages}` : passages;
}
