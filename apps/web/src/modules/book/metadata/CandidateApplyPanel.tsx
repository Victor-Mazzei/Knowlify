import type { BookMetadata, MetadataCandidate } from "../types";
import {
  CANDIDATE_LABELS,
  availableCandidateFields,
  candidateProblem,
  candidateValue,
  currentValue,
  type CandidateField,
} from "./applyCandidate";
import { SOURCE_LABEL } from "./CandidateList";

/**
 * Field-by-field review between the stored detail and one provider candidate. Applying
 * is an explicit action; the cover is the only optional row because it is downloaded.
 */
export function CandidateApplyPanel({
  candidate,
  current,
  fields,
  cover,
  applying,
  onToggle,
  onCover,
  onApply,
}: {
  candidate: MetadataCandidate;
  current: BookMetadata;
  fields: ReadonlySet<CandidateField>;
  cover: boolean;
  applying: boolean;
  onToggle: (field: CandidateField) => void;
  onCover: (value: boolean) => void;
  onApply: () => void;
}) {
  const available = availableCandidateFields(candidate);
  const count = fields.size + (cover && candidate.coverUrl ? 1 : 0);
  return (
    <section className="metadata-apply" aria-label="Fields to apply">
      <h3>Apply from {SOURCE_LABEL[candidate.source]}</h3>
      <p className="metadata-hint">
        Choose the fields to copy. Your current values change only after you apply.
      </p>
      <div className="metadata-compare" role="group" aria-label="Metadata fields">
        <div className="metadata-compare-head" aria-hidden="true">
          <span />
          <span>Field</span>
          <span>Current</span>
          <span>Match</span>
        </div>
        {available.map((field) => {
          const problem = candidateProblem(candidate, field);
          const value = candidateValue(candidate, field) ?? "";
          const before = currentValue(current, field);
          return (
            <label key={field} className={`metadata-compare-row${problem ? " has-problem" : ""}`}>
              <input
                type="checkbox"
                checked={fields.has(field)}
                disabled={applying || problem !== null}
                aria-label={`Apply ${CANDIDATE_LABELS[field]}`}
                onChange={() => onToggle(field)}
              />
              <span className="metadata-compare-field">{CANDIDATE_LABELS[field]}</span>
              <span className="metadata-compare-current">{before || <span className="metadata-unset">Not set</span>}</span>
              <span className="metadata-compare-value">
                {value || <span className="metadata-unset">Not provided</span>}
                {problem && <span className="metadata-compare-problem">{problem}</span>}
              </span>
            </label>
          );
        })}
        {candidate.coverUrl && (
          <label className="metadata-compare-row metadata-compare-cover">
            <input
              type="checkbox"
              checked={cover}
              disabled={applying}
              aria-label="Apply cover"
              onChange={(event) => onCover(event.target.checked)}
            />
            <span className="metadata-compare-field">Cover</span>
            <span className="metadata-compare-current">Current cover stays unless you apply this one.</span>
            <span className="metadata-compare-value">
              <img src={candidate.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
            </span>
          </label>
        )}
      </div>
      <div className="metadata-apply-actions">
        <span className="metadata-hint">{count === 0 ? "Nothing selected" : `${count} selected`}</span>
        <button type="button" className="primary" onClick={onApply} disabled={applying || count === 0}>
          {applying ? "Applying…" : count === 1 ? "Apply 1 change" : `Apply ${count} changes`}
        </button>
      </div>
    </section>
  );
}
