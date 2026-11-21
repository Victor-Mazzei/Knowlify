import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { formatBytes, formatCount, formatPercent } from "./format";
import { DuplicateGroupList } from "./DuplicateGroupList";
import { MergeDialog } from "./MergeDialog";
import type { DuplicateGroup, MergeResult, MergeTarget } from "./types";
import { useDuplicates } from "./useDuplicates";
import "./duplicates.css";

/** Settings card: summary, canonical choice per group, and the reviewed merge flow. */
export function DuplicatesCard({ api }: { api: ApiFn }) {
  const {
    groups,
    summary,
    nextCursor,
    scan,
    loading,
    loadingMore,
    busy,
    error,
    unavailable,
    reload,
    loadMore,
    startScan,
    dryRun,
    merge,
    mergeAll,
  } = useDuplicates(api);
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<MergeTarget[] | "all" | null>(null);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const canonicalFor = (group: DuplicateGroup) => {
    const chosen = choices[group.key];
    return chosen && group.books.some((book) => book.id === chosen) ? chosen : group.canonicalId;
  };
  const loaded: MergeTarget[] = groups.map((group) => ({ key: group.key, canonicalId: canonicalFor(group) }));
  const manualChoices = groups.some((group) => canonicalFor(group) !== group.canonicalId);
  const analyzing = scan?.state === "hashing";
  const percent = formatPercent(scan?.progress);

  useEffect(() => {
    if (location.hash !== "#duplicates") return;
    const node = section.current;
    if (!node) return;
    const header = document.querySelector<HTMLElement>(".app > header");
    if (header) node.style.scrollMarginTop = `${Math.round(header.getBoundingClientRect().height + 12)}px`;
    if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start" });
    node.focus({ preventScroll: true });
  }, [location.hash]);

  if (unavailable) return null;

  function finish(result: MergeResult) {
    const parts: string[] = [];
    if (result.merged > 0) {
      parts.push(`Merged ${formatCount(result.merged)} ${result.merged === 1 ? "group" : "groups"}.`);
    } else {
      parts.push("Nothing was merged.");
    }
    if (result.booksRemoved > 0) {
      parts.push(`${formatCount(result.booksRemoved)} duplicate ${result.booksRemoved === 1 ? "record" : "records"} removed.`);
    }
    if (result.skipped.length > 0) {
      parts.push(
        `${formatCount(result.skipped.length)} ${result.skipped.length === 1 ? "group changed" : "groups changed"} while reviewing; analyze again to refresh.`,
      );
    }
    if ((result.remaining ?? 0) > 0) {
      const remaining = result.remaining ?? 0;
      parts.push(
        `${formatCount(remaining)} ${remaining === 1 ? "group still needs" : "groups still need"} review.`,
      );
    }
    const clean = result.merged > 0 && result.skipped.length === 0 && (result.remaining ?? 0) === 0;
    setOutcome({ tone: clean ? "ok" : "warn", text: parts.join(" ") });
    setTarget(null);
  }

  const groupCount = summary?.groups ?? 0;
  const loadedLabel = nextCursor
    ? `${formatCount(groups.length)} of ${formatCount(groupCount)} groups loaded`
    : `${formatCount(groups.length)} ${groups.length === 1 ? "group" : "groups"}`;

  return (
    <section
      id="duplicates"
      ref={section}
      tabIndex={-1}
      className="setting-card duplicates-card"
      aria-labelledby="set-duplicates"
    >
      <div className="duplicates-head">
        <div>
          <h2 id="set-duplicates">Duplicates</h2>
          <p className="muted">Books are compared by file content, so renamed copies are found too.</p>
        </div>
        {analyzing ? (
          <span className="dup-analyzing" role="status" aria-live="polite">
            Analyzing…{percent === null ? "" : ` ${percent}%`}
          </span>
        ) : (
          <button
            className="ghost bordered"
            onClick={() => void startScan()}
            disabled={busy !== null || loading}
          >
            {busy === "scan" ? "Analyzing…" : "Analyze now"}
          </button>
        )}
      </div>

      {analyzing && percent !== null && (
        <span
          className="dup-progress"
          role="progressbar"
          aria-label="Analyzing duplicate groups"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className="dup-progress-fill" style={{ width: `${percent}%` }} />
        </span>
      )}

      {error && (
        <div className="duplicates-feedback" role="alert">
          <span>{error}</span>
          <button className="ghost bordered" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      )}
      {outcome && (
        <p className="notice dup-outcome" data-tone={outcome.tone} role="status">
          {outcome.text}
        </p>
      )}

      {loading && groups.length === 0 ? (
        <p className="muted dup-loading" role="status">
          Looking for duplicates…
        </p>
      ) : groups.length === 0 ? (
        <div className="dup-empty">
          <strong>No duplicates found.</strong>
          <p className="muted">Knowlify compares file contents. Run Analyze now after adding books.</p>
        </div>
      ) : (
        <>
          {summary && (
            <p className="dup-summary">
              {formatCount(summary.groups)} {summary.groups === 1 ? "group" : "groups"} ·{" "}
              {formatCount(summary.redundantBooks)} redundant {summary.redundantBooks === 1 ? "book" : "books"}
              {summary.reclaimableBytes > 0 && <> · ~{formatBytes(summary.reclaimableBytes)} of index</>}
            </p>
          )}
          <DuplicateGroupList
            groups={groups}
            choices={choices}
            onChoose={(groupKey, bookId) => setChoices((current) => ({ ...current, [groupKey]: bookId }))}
            disabled={analyzing || busy !== null || loading}
          />
          <div className="duplicates-actions">
            <span className="muted dup-loaded">{loadedLabel}</span>
            {nextCursor && (
              <button
                className="ghost bordered"
                onClick={() => void loadMore()}
                disabled={loadingMore || busy !== null || loading}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
            <button
              className="primary"
              onClick={() => {
                setOutcome(null);
                setTarget(loaded);
              }}
              disabled={analyzing || busy !== null || loading || loaded.length === 0}
            >
              Review &amp; merge
            </button>
            <button
              className="ghost bordered"
              onClick={() => {
                setOutcome(null);
                setTarget("all");
              }}
              disabled={analyzing || busy !== null || loading || groupCount === 0}
            >
              Merge all
            </button>
          </div>
          {nextCursor && (
            <p className="muted dup-scope">
              Review &amp; merge covers the groups loaded here; Merge all checks every group before you confirm.
            </p>
          )}
        </>
      )}

      {target !== null && (
        <MergeDialog
          target={target}
          groupCount={target === "all" ? groupCount : target.length}
          hasManualChoices={target === "all" && manualChoices}
          onDryRun={() => dryRun(target)}
          onMerge={target === "all" ? mergeAll : merge}
          onMerged={finish}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  );
}
