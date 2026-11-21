import type { MetadataCandidate } from "../types";
import { candidateKey } from "./applyCandidate";

export const SOURCE_LABEL: Record<MetadataCandidate["source"], string> = {
  googlebooks: "Google Books",
  openlibrary: "Open Library",
};

/** Provider matches as a single-choice list; each row is one button. */
export function CandidateList({
  candidates,
  selected,
  disabled,
  onSelect,
}: {
  candidates: MetadataCandidate[];
  selected: string | null;
  disabled: boolean;
  onSelect: (candidate: MetadataCandidate) => void;
}) {
  return (
    <ul className="metadata-candidates" aria-label="Metadata matches">
      {candidates.map((candidate) => {
        const key = candidateKey(candidate);
        const isbn = candidate.isbn13 ?? candidate.isbn10;
        return (
          <li key={key}>
            <button
              type="button"
              className="metadata-candidate"
              aria-pressed={selected === key}
              disabled={disabled}
              onClick={() => onSelect(candidate)}
            >
              <span className="metadata-candidate-cover" aria-hidden="true">
                {candidate.coverUrl ? (
                  <img
                    src={candidate.coverUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                    }}
                  />
                ) : (
                  <span>{SOURCE_LABEL[candidate.source].slice(0, 2).toUpperCase()}</span>
                )}
              </span>
              <span className="metadata-candidate-body">
                <span className="metadata-candidate-title">{candidate.title}</span>
                {candidate.authors.length > 0 && (
                  <span className="metadata-candidate-authors">{candidate.authors.join(", ")}</span>
                )}
                <span className="metadata-candidate-meta">
                  {SOURCE_LABEL[candidate.source]}
                  {candidate.year !== null && <> · {candidate.year}</>}
                  {candidate.publisher && <> · {candidate.publisher}</>}
                </span>
                {isbn && <span className="metadata-candidate-isbn">ISBN {isbn}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
