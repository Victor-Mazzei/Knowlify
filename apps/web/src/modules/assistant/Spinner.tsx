/**
 * Small "the tutor is working" indicator. The visible mark is decorative; the
 * hidden status text is what screen readers announce. Reduced motion swaps the
 * spinning ring for three static dots.
 */
export function Spinner({ label, inline = false }: { label: string; inline?: boolean }) {
  return (
    <span className={inline ? "asst-spinner asst-spinner-inline" : "asst-spinner"} role="status">
      <span className="asst-spinner-ring" aria-hidden="true" />
      <span className="asst-spinner-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="asst-visually-hidden">{label}</span>
    </span>
  );
}
