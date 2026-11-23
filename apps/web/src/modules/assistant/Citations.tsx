import { Link } from "react-router-dom";
import { citationHref } from "./MarkerChips";
import { MarkdownMessage } from "./markdown/Markdown";
import type { Citation, RecommendedBook } from "./types";

const citationLocation = (citation: Citation) => {
  const parts = [citation.section, citation.page === null ? "" : `page ${citation.page}`].filter(Boolean);
  return parts.join(" · ");
};

/**
 * Answer text is rendered as Markdown, never as HTML. The Markdown renderer
 * turns `[n]` and `[book:n]` markers that match real data into the same chips
 * as before, and leaves every other marker as text (or hides an unknown book
 * marker). Model output cannot inject markup.
 */
export function AnswerText({
  text,
  citations,
  books,
  onOpenBook,
  partial = false,
}: {
  text: string;
  citations: Citation[] | null;
  books?: RecommendedBook[];
  onOpenBook?: () => void;
  /** Streaming or incomplete: close pending emphasis/code for display only. */
  partial?: boolean;
}) {
  return (
    <MarkdownMessage
      text={text}
      citations={citations}
      books={books}
      onOpenBook={onOpenBook}
      partial={partial}
    />
  );
}

export function Sources({ citations }: { citations: Citation[] | null }) {
  if (!citations?.length) return null;
  return (
    <details className="asst-sources">
      <summary>
        {citations.length} {citations.length === 1 ? "source" : "sources"}
      </summary>
      <ol>
        {citations.map((citation) => (
          <li key={citation.passageId}>
            <Link to={citationHref(citation)}>
              <span className="asst-source-n">[{citation.n}]</span> <span className="asst-source-title">{citation.bookTitle}</span>
            </Link>
            {citationLocation(citation) && <small>{citationLocation(citation)}</small>}
          </li>
        ))}
      </ol>
    </details>
  );
}
