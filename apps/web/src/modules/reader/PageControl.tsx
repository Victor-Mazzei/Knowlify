import { useEffect, useState } from "react";

export function PageControl({
  page,
  total,
  onChange,
  onStep,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
  onStep: (delta: 1 | -1) => void;
}) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);
  const commit = () => {
    const next = Math.round(Number(draft));
    if (Number.isFinite(next) && next >= 1 && next <= total && next !== page) onChange(next);
    else setDraft(String(page));
  };
  return (
    <div className="pager">
      <button aria-label="Previous page" disabled={page <= 1} onClick={() => onStep(-1)}>
        ←
      </button>
      <span className="page-field">
        <input
          className="page-input"
          aria-label="Current page"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && (event.currentTarget.blur(), undefined)}
        />
        <span>/ {total}</span>
      </span>
      <button aria-label="Next page" disabled={page >= total} onClick={() => onStep(1)}>
        →
      </button>
    </div>
  );
}
