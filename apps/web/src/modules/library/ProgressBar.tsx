import { formatRemaining } from "./readingProgress";

/**
 * Thin reading-progress rule with the remaining amount spelled out in text, so
 * the information is never carried by color alone.
 */
export function ProgressBar({ percentage }: { percentage?: number | null }) {
  const remaining = formatRemaining(percentage);
  if (!remaining) return null;
  return (
    <div className="progress">
      <span className="progress-text">{remaining.label}</span>
      <span
        className="progress-track"
        role="progressbar"
        aria-label="Reading progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining.read}
        aria-valuetext={remaining.label}
      >
        <span className="progress-fill" style={{ width: `${remaining.read}%` }} />
      </span>
    </div>
  );
}
