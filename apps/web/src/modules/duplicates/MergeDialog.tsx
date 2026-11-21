import { useCallback, useEffect, useRef, useState } from "react";
import { useDialogKeys } from "../../components/dialogs";
import { formatError } from "../../services/api";
import { MERGE_GROUPS_LIMIT } from "./duplicatesApi";
import { formatBytes, formatCount } from "./format";
import type { MergeResult, MergeReview, MergeTarget } from "./types";

function PlanRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Dry-run review before a merge. The dialog owns the async work: it asks for
 * the plan on mount, then confirms the same target. Nothing is written until
 * the confirm button runs.
 */
export function MergeDialog({
  target,
  groupCount,
  hasManualChoices,
  onDryRun,
  onMerge,
  onMerged,
  onClose,
}: {
  target: MergeTarget[] | "all";
  groupCount: number;
  hasManualChoices: boolean;
  onDryRun: () => Promise<MergeReview>;
  onMerge: () => Promise<MergeResult>;
  onMerged: (result: MergeResult) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const dryRunRef = useRef(onDryRun);
  dryRunRef.current = onDryRun;
  const [plan, setPlan] = useState<MergeReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const close = useCallback(() => {
    if (!merging) onClose();
  }, [merging, onClose]);
  useDialogKeys(ref, close);

  useEffect(() => {
    cancelRef.current?.focus();
    const previous = opener.current as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    let active = true;
    setPlan(null);
    setError("");
    setLoading(true);
    dryRunRef.current().then(
      (result) => {
        if (!active) return;
        setPlan(result);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(formatError(reason));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  async function confirm() {
    if (!plan || merging) return;
    setMerging(true);
    setError("");
    try {
      const result = await onMerge();
      onMerged(result);
    } catch (e) {
      setError(formatError(e));
      setMerging(false);
    }
  }

  const accepted = plan?.accepted ?? null;
  const omitted = plan?.omitted ?? [];
  const legacy = plan !== null && plan.accepted === null;
  const requested = plan?.requested ?? groupCount;
  const count = accepted?.length ?? 0;
  const nothing = plan !== null && (requested === 0 || count === 0);
  const incomplete = plan !== null && count > 0 && omitted.length > 0;
  const batches = accepted === null ? 0 : Math.ceil(accepted.length / MERGE_GROUPS_LIMIT);
  const confirmLabel = incomplete
    ? `Merge ${formatCount(count)} of ${formatCount(requested)} groups`
    : target === "all"
      ? `Merge all ${formatCount(count)} ${count === 1 ? "group" : "groups"}`
      : `Merge ${formatCount(count)} ${count === 1 ? "group" : "groups"}`;
  const closes = plan !== null && (legacy || nothing);

  return (
    <div className="dialog-backdrop centered" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        ref={ref}
        className="confirm-dialog dup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dup-merge-title"
        aria-describedby="dup-safety"
        aria-busy={loading || merging}
      >
        <h2 id="dup-merge-title">
          {target === "all" ? "Merge every duplicate?" : `Review ${formatCount(groupCount)} ${groupCount === 1 ? "group" : "groups"}`}
        </h2>
        <p className="muted">
          {target === "all"
            ? "Knowlify keeps one copy of each book and chooses the canonical copy for every group."
            : "Reviewing the groups loaded below. Use Merge all to cover the remaining groups at once."}
        </p>
        <p className="dup-safety" id="dup-safety">
          Notes and progress are kept. Files in your folders are never deleted.
        </p>

        <div className="dup-dialog-body">
          {loading && (
            <p className="muted" role="status">
              {target === "all" && groupCount > 0
                ? `Checking all ${formatCount(groupCount)} groups…`
                : "Checking what will be merged…"}
            </p>
          )}
          {plan && (
            <>
              <dl className="dup-plan" aria-label="Merge plan">
                <PlanRow label="Groups" value={formatCount(plan.plan.groups)} />
                <PlanRow label="Duplicate records removed" value={formatCount(plan.plan.booksRemoved)} />
                {plan.plan.notesMoved > 0 && <PlanRow label="Notes moved" value={formatCount(plan.plan.notesMoved)} />}
                {plan.plan.conversationsMoved > 0 && (
                  <PlanRow label="Conversations moved" value={formatCount(plan.plan.conversationsMoved)} />
                )}
                {plan.plan.progressKept > 0 && (
                  <PlanRow label="Reading progress kept" value={formatCount(plan.plan.progressKept)} />
                )}
                {plan.plan.indexesDropped > 0 && (
                  <PlanRow label="Search indexes dropped" value={formatCount(plan.plan.indexesDropped)} />
                )}
                {plan.plan.managedFilesRemoved > 0 && (
                  <PlanRow label="Uploaded copies removed" value={formatCount(plan.plan.managedFilesRemoved)} />
                )}
                <PlanRow label="Index space reclaimed" value={`~${formatBytes(plan.plan.reclaimableBytes)}`} />
              </dl>
              {batches > 1 && (
                <p className="muted">
                  This merge runs in {formatCount(batches)} batches of up to {formatCount(MERGE_GROUPS_LIMIT)} groups.
                  The totals above cover every batch.
                </p>
              )}
              {target === "all" && hasManualChoices && (
                <p className="dup-warning">Your manual canonical choices apply only to Review &amp; merge.</p>
              )}
              {omitted.length > 0 && (
                <p className="dup-warning">
                  {formatCount(omitted.length)} {omitted.length === 1 ? "group changed" : "groups changed"} and{" "}
                  {omitted.length === 1 ? "was" : "were"} left out. Analyze again to refresh{" "}
                  {omitted.length === 1 ? "that group" : "those groups"}; this merge does not include{" "}
                  {omitted.length === 1 ? "it" : "them"}.
                </p>
              )}
              {plan.warnings.length > 0 && (
                <ul className="dup-warnings" aria-label="Merge warnings">
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              {legacy && (
                <p className="muted">
                  This server does not support reviewed merges. The plan is shown for reference only.
                </p>
              )}
            </>
          )}
          {error && (
            <div className="dup-dialog-feedback">
              <p className="error" role="alert">
                {error}
              </p>
              {!plan && (
                <button className="ghost bordered" onClick={() => setAttempt((value) => value + 1)}>
                  Try again
                </button>
              )}
            </div>
          )}
          {nothing && !legacy && <p className="muted">Nothing left to merge.</p>}
        </div>

        <div className="confirm-actions">
          <button ref={cancelRef} className="ghost bordered" onClick={close} disabled={merging}>
            {closes ? "Close" : "Cancel"}
          </button>
          {plan && !legacy && (
            <button
              className="primary danger"
              onClick={() => void confirm()}
              disabled={merging || count === 0}
              aria-busy={merging}
            >
              {count === 0 ? "Nothing to merge" : merging ? "Merging…" : confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
