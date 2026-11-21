import type { ReactNode } from "react";

export function MetadataField({
  id,
  label,
  origin,
  error,
  hint,
  wide,
  onReset,
  children,
}: {
  id: string;
  label: string;
  origin: "edited" | "file" | "unset";
  error?: string;
  hint?: ReactNode;
  wide?: boolean;
  onReset?: (() => void) | null;
  children: ReactNode;
}) {
  const state = origin === "edited" ? "Edited" : origin === "file" ? "From file" : "Not set";
  return (
    <div className={`metadata-field${wide ? " metadata-field-wide" : ""}`}>
      <div className="metadata-label-row">
        <label htmlFor={id}>{label}</label>
        <span className={`metadata-origin metadata-origin-${origin}`}>{state}</span>
        {onReset && (
          <button
            type="button"
            className="metadata-reset-field"
            aria-label={`Reset ${label} to file`}
            onClick={onReset}
          >
            Reset
          </button>
        )}
      </div>
      {children}
      {error ? (
        <p className="metadata-field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="metadata-hint">{hint}</p>
      )}
    </div>
  );
}
