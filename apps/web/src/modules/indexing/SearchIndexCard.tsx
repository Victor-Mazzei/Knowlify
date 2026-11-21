import type { ApiFn } from "../../components/dialogs";
import { useConfirm } from "../../components/dialogs";
import { useIndexStatusContext } from "./IndexStatusContext";
import { describeVectorPolicy, formatRate, formatTimeLeft, formatWorkers } from "./indexStatusText";
import { useIndexPause } from "./useIndexPause";
import { useReindex } from "./useReindex";
import type { IndexSearchStatus } from "./types";

/** Settings card: queue counts, runtime, vector policy and the bulk actions. */
export function SearchIndexCard({ api }: { api: ApiFn }) {
  const { status, available, refresh } = useIndexStatusContext();
  const pause = useIndexPause(api, status?.paused, refresh);
  const { reindex, busy: reindexing, error, queued } = useReindex(api);
  const { ask, dialog } = useConfirm();

  if (!available || !status) return null;

  async function run(scope: "failed" | "all") {
    const result = await reindex(scope);
    if (result) await refresh();
  }

  async function reindexAll() {
    const ok = await ask({
      title: "Reindex every book?",
      message: "This rebuilds the search index for all books. It runs in the background and can take a while.",
      confirmLabel: "Reindex all",
    });
    if (ok) await run("all");
  }

  const { pending, indexing, ready, error: failed } = status.counts;
  const paused = pause.paused;
  const hasWork = pending + indexing > 0;
  const canPause = status.enabled && typeof status.paused === "boolean";
  const disabled = reindexing || pause.pending || !status.enabled;
  const rate = formatRate(status.rate);
  const eta = paused ? null : formatTimeLeft(status.etaSec);
  const workers = formatWorkers(status.workers);
  const stateLabel = paused ? "Paused" : hasWork ? "Running" : "Idle";
  const hasRuntime = typeof status.paused === "boolean" || rate !== null || eta !== null || workers !== null;

  return (
    <section className="setting-card" aria-labelledby="set-search-index">
      <h2 id="set-search-index">Search index</h2>
      <p className="muted">Find passages by wording and meaning. Indexing runs in the background.</p>
      {!status.enabled ? (
        <p className="muted">Search indexing is turned off on the server. Books are still readable.</p>
      ) : (
        <>
          <dl className="index-counts">
            <div>
              <dt>Searchable</dt>
              <dd>{ready}</dd>
            </div>
            <div>
              <dt>Queued</dt>
              <dd>{pending}</dd>
            </div>
            <div>
              <dt>In progress</dt>
              <dd>{indexing}</dd>
            </div>
            <div>
              <dt>Failed</dt>
              <dd>{failed}</dd>
            </div>
          </dl>
          {hasRuntime && (
            <p className="index-runtime">
              <span className={paused ? "index-paused" : undefined} role="status" aria-live="polite">
                {stateLabel}
              </span>
              {workers && <span>{workers}</span>}
              {!paused && rate && <span>{rate}</span>}
              {!paused && eta && <span className="index-eta">{eta}</span>}
            </p>
          )}
          <p className="muted">{embedderSummary(status.search)}</p>
          {status.vectors && (
            <p className="index-vectors">
              <span className="index-vectors-label">Vectors:</span> {describeVectorPolicy(status.vectors)}{" "}
              {status.vectors.mode === "auto" && status.vectors.maxBooks > 0
                ? "Vector search uses more disk; use Index on a book to add them."
                : "Use Index on a book to add vectors when you need them."}
            </p>
          )}
          <div className="index-actions">
            {canPause && (paused || hasWork) && (
              <button
                className="ghost bordered"
                aria-pressed={paused}
                aria-busy={pause.pending}
                disabled={pause.pending}
                onClick={() => void pause.toggle()}
              >
                {pause.pending ? (paused ? "Pausing…" : "Resuming…") : paused ? "Resume indexing" : "Pause indexing"}
              </button>
            )}
            <button className="ghost bordered" disabled={disabled || failed === 0} onClick={() => void run("failed")}>
              Retry failed
            </button>
            <button className="ghost bordered" disabled={disabled} onClick={() => void reindexAll()}>
              {reindexing ? "Queueing…" : "Reindex all"}
            </button>
          </div>
          {pause.error && (
            <p className="error" role="alert">
              {pause.error}
            </p>
          )}
          {queued !== null && (
            <p className="muted" role="status">
              {queued === 0 ? "Nothing needed reindexing." : `${queued} ${queued === 1 ? "book" : "books"} queued.`}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
      {dialog}
    </section>
  );
}

function embedderSummary(search: IndexSearchStatus): string {
  if (search.embeddings === "none") return "Word search only. Semantic search is off.";
  if (search.state === "loading") return "Loading the embedding model…";
  if (search.state === "unavailable") return "Semantic search is unavailable right now. Word search still works.";
  if (search.state === "ready") return `Semantic search is on${search.model ? ` with ${search.model}` : ""}.`;
  return "Semantic search is off. Word search still works.";
}
