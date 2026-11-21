import type { ApiFn } from "../../components/dialogs";
import { DuplicatesSkippedLink } from "../duplicates/DuplicatesSkippedLink";
import { readSkippedDuplicates } from "../duplicates/parse";
import type { ScanStatus } from "../../types";
import { formatRate, formatTimeLeft, formatWorkers } from "./indexStatusText";
import { useIndexPause } from "./useIndexPause";
import type { IndexStatusResponse } from "./types";

/**
 * One quiet header indicator. Metadata imports win over search indexing at the
 * same moment; the chip disappears when both are idle. Pause/resume only
 * appears when the server exposes the persisted state.
 */
export function IndexChip({
  scanStatus,
  index,
  scanError,
  api,
  refresh,
}: {
  scanStatus: ScanStatus;
  index: IndexStatusResponse | null;
  /** The scan status could not be refreshed; its numbers may be stale. */
  scanError: boolean;
  api: ApiFn;
  refresh: () => Promise<unknown>;
}) {
  const pause = useIndexPause(api, index?.paused, refresh);
  const skipped = readSkippedDuplicates(scanStatus);
  // A failed refresh may leave stale numbers behind; only link while the status is trustworthy.
  const skippedLink = !scanError && skipped > 0 ? <DuplicatesSkippedLink count={skipped} /> : null;

  if (scanError) {
    return (
      <span className="index-chip error-status" role="status" aria-live="polite">
        Can&apos;t reach the server. Retrying…
      </span>
    );
  }
  if (scanStatus.scanning || scanStatus.pending > 0) {
    const count = scanStatus.pending;
    const label = count > 0 ? `Importing ${count} ${count === 1 ? "book" : "books"}` : "Importing library";
    const detail = count > 0 ? `Reading details and covers for ${count} ${count === 1 ? "book" : "books"}.` : "Reading details and covers from your folders.";
    return (
      <span className="index-chip-cluster">
        <Chip label={label} detail={detail} />
        {skippedLink}
      </span>
    );
  }
  if (!index) return skippedLink ? <span className="index-chip-cluster">{skippedLink}</span> : null;

  const { pending, indexing, ready, error: failed } = index.counts;
  const paused = index.enabled && pause.paused;
  if (pending + indexing === 0 && !paused) {
    return skippedLink ? <span className="index-chip-cluster">{skippedLink}</span> : null;
  }

  const total = pending + indexing + ready + failed;
  const progress = index.current?.progress;
  const eta = paused ? null : formatTimeLeft(index.etaSec);
  const rate = formatRate(index.rate);
  const workers = formatWorkers(index.workers);
  const detail = [
    `${pending} queued`,
    `${indexing} in progress`,
    `${ready} searchable`,
    `${failed} failed`,
    progress === null || progress === undefined ? null : `${Math.round(progress * 100)}% of the current book`,
    workers,
    rate,
    paused ? null : eta,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const label = paused ? "Indexing paused" : `Indexing for search ${ready} of ${total}`;
  const canPause = index.enabled && typeof index.paused === "boolean";

  return (
    <span className="index-chip-cluster">
      <span
        className={`index-chip${paused ? " paused" : ""}`}
        role="status"
        aria-live="polite"
        title={detail}
      >
        {label}
        {eta ? ` · ${eta}` : ""}
      </span>
      {canPause && (
        <button
          type="button"
          className="ghost index-chip-action"
          aria-pressed={paused}
          aria-busy={pause.pending}
          aria-label={paused ? "Resume search indexing" : "Pause search indexing"}
          title={pause.error || undefined}
          disabled={pause.pending}
          onClick={() => void pause.toggle()}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      )}
      {skippedLink}
      {pause.error && (
        <span className="visually-hidden" role="alert">
          {pause.error}
        </span>
      )}
    </span>
  );
}

function Chip({ label, detail }: { label: string; detail: string }) {
  return (
    <span className="index-chip" role="status" aria-live="polite" title={detail}>
      {label}
    </span>
  );
}
