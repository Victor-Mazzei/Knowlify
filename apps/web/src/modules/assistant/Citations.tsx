import { Link } from "react-router-dom";
import type { Citation } from "./types";

const citationHref = (citation: Citation) =>
  `/read/${encodeURIComponent(citation.bookId)}${citation.page === null ? "" : `?at=${citation.page}`}`;

const citationLocation = (citation: Citation) => {
  const parts = [citation.section, citation.page === null ? "" : `page ${citation.page}`].filter(Boolean);
  return parts.join(" · ");
};

function CitationChip({ citation }: { citation: Citation }) {
  return (
    <Link
      className="asst-cite"
      to={citationHref(citation)}
      title={`${citation.bookTitle}${citation.page === null ? "" : `, page ${citation.page}`}`}
      aria-label={`Source ${citation.n}: ${citation.bookTitle}${citation.page === null ? "" : `, page ${citation.page}`}`}
    >
      {citation.n}
    </Link>
  );
}

/**
 * Answer text is rendered as text: only `[n]` markers that match a real citation
 * become links, so model output cannot inject markup.
 */
export function AnswerText({ text, citations }: { text: string; citations: Citation[] | null }) {
  const byNumber = new Map((citations ?? []).map((citation) => [citation.n, citation]));
  return (
    <p className="asst-answer">
      {text.split(/(\[\d+\])/g).map((part, index) => {
        const match = /^\[(\d+)\]$/.exec(part);
        const citation = match ? byNumber.get(Number(match[1])) : undefined;
        return citation ? <CitationChip key={index} citation={citation} /> : <span key={index}>{part}</span>;
      })}
    </p>
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
