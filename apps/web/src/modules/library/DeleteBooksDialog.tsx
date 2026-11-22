import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { useDialogKeys } from "../../components/dialogs";
import { ApiError, formatError } from "../../services/api";
import type { BookSelection, DeleteDryRun, DeleteResult } from "../../types";
import {
  numberField,
  parseDeletePartial,
  partialMessage,
  remainingSelection,
  removedIdsOf,
  requestDelete,
  requestDeleteDryRun,
  selectionSize,
  type DeleteProgress,
} from "./deleteBooksApi";
import "./delete-dialog.css";

const countFormat = new Intl.NumberFormat("en-US");
const count = (value: number) => countFormat.format(value);
const plural = (value: number, one: string, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`;

/**
 * Strong confirmation for single and bulk deletion. The dialog reviews the
 * server's dry run first; notes require an explicit checkbox and large or
 * filtered selections require typing `delete`.
 *
 * A `selection_changed` 409 that carries the remainder means earlier blocks may
 * have been deleted. The dialog reports that progress, narrows the selection to
 * the server's remainder and reviews it again before asking for a new
 * confirmation.
 */
export function DeleteBooksDialog({
  api,
  selection,
  onDeleted,
  onPartial,
  onClose,
}: {
  api: ApiFn;
  selection: BookSelection;
  onDeleted: (result: DeleteResult, selection: BookSelection) => void;
  /** Earlier blocks already committed; the page must drop them from the list and selection. */
  onPartial?: (progress: DeleteProgress) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previous = useRef<Element | null>(document.activeElement);
  const [current, setCurrent] = useState<BookSelection>(selection);
  const [dry, setDry] = useState<DeleteDryRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState("");
  const [notesConfirmed, setNotesConfirmed] = useState(false);
  const [typed, setTyped] = useState("");
  const initialTotal = useRef(selectionSize(selection));
  const removedBefore = useRef(0);
  // A browser blurs the focused Cancel button when `busy` disables it. Restore the
  // focus only after the button is enabled again; a synchronous focus() would be a
  // no-op in that window, and tests only saw it pass because jsdom keeps focus.
  const refocusCancel = useRef(false);
  // A deletion in flight cannot be stopped; closing would hide its outcome and
  // allow a second dialog to start a concurrent deletion.
  const close = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);
  useDialogKeys(ref, close);

  const review = useCallback(
    async (target: BookSelection, retried = false) => {
      setLoading(true);
      setError("");
      // The old report belongs to a selection that is no longer current; keeping it
      // would leave the destructive button enabled against a stale impact summary.
      setDry(null);
      try {
        setDry(await requestDeleteDryRun(api, target));
        setCurrent(target);
      } catch (e) {
        if (e instanceof ApiError && e.code === "selection_changed" && "filter" in target && !retried) {
          const total = numberField(e.details?.total);
          setConflict(
            `The filter now matches ${count(total)} ${total === 1 ? "book" : "books"}. Review the updated selection.`,
          );
          await review({ filter: target.filter, expectedTotal: total }, true);
          return;
        }
        setError(e instanceof ApiError ? e.message : formatError(e));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    cancelRef.current?.focus();
    void review(selection);
    const opener = previous.current as HTMLElement | null;
    return () => opener?.focus?.();
  }, [review, selection]);

  useEffect(() => {
    if (busy || !refocusCancel.current) return;
    refocusCancel.current = false;
    cancelRef.current?.focus();
  }, [busy]);

  const books = dry?.books ?? 0;
  const notes = dry?.notes ?? 0;
  const needsTyping = books >= 10 || "filter" in current;
  const canDelete =
    dry !== null && !busy && !loading && (notes === 0 || notesConfirmed) &&
    (!needsTyping || typed.trim().toLocaleLowerCase() === "delete");

  async function execute() {
    if (!canDelete) return;
    setBusy(true);
    setError("");
    try {
      const result = await requestDelete(api, current, notesConfirmed && notes > 0);
      onDeleted({ ...result, removed: removedBefore.current + result.removed }, current);
    } catch (e) {
      const partial = parseDeletePartial(e);
      if (partial) {
        const done = removedBefore.current + partial.removed;
        removedBefore.current = done;
        const remaining = remainingSelection(current, partial);
        const remainingCount = remaining === null ? 0 : selectionSize(remaining);
        setConflict(partialMessage(initialTotal.current, done, remainingCount));
        setNotesConfirmed(false);
        setTyped("");
        onPartial?.({ removedIds: removedIdsOf(current, partial), remaining });
        refocusCancel.current = true;
        if (remaining === null) {
          onDeleted(
            { removed: done, missing: 0, notesRemoved: 0, ignored: 0, filesRemoved: 0, fileErrors: 0, remaining: 0 },
            { ids: [] },
          );
        } else {
          await review(remaining);
        }
      } else if (e instanceof ApiError && e.code === "selection_changed" && "filter" in current) {
        setConflict("The selection changed before the deletion. Review the new total and confirm again.");
        await review(current);
      } else if (e instanceof ApiError && e.code === "notes_confirmation_required") {
        // A note appeared after the dry run, so the current report shows no notes
        // and offers no checkbox to confirm them. Review again to expose it.
        setNotesConfirmed(false);
        setConflict("Some selected books now have notes. Review the updated impact and confirm again.");
        await review(current);
      } else {
        setError(e instanceof ApiError ? e.message : formatError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop centered" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        ref={ref}
        className="confirm-dialog delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-message"
      >
        <h2 id="delete-title">{loading ? "Delete books?" : `Delete ${plural(books, "book")}?`}</h2>
        {loading && (
          <p className="muted" role="status">
            Reviewing the selection…
          </p>
        )}
        {dry && (
          <div id="delete-message" className="delete-message">
            <p>
              <strong>{plural(books, "book")}</strong> will be removed from your library. Notes ({count(notes)}), chat
              history ({count(dry.conversations)}), reading progress ({count(dry.withProgress)}) and the search index
              ({count(dry.indexed)}) will be deleted for {books === 1 ? "this book" : "these books"}. This cannot be
              undone.
            </p>
            <p className="delete-safe">
              Files in your library folders are never touched, and the books will not be re-imported (Settings →
              Ignored books).
            </p>
            {dry.externalBooks > 0 && (
              <p>
                {dry.externalBooks === 1
                  ? "1 book lives in a library folder; its file stays untouched."
                  : `${count(dry.externalBooks)} books live in library folders; their files stay untouched.`}
              </p>
            )}
            {dry.managedFiles > 0 && (
              <p>{plural(dry.managedFiles, "uploaded file")} will be deleted from Knowlify storage.</p>
            )}
            {notes > 0 && (
              <label className="delete-note-confirm">
                <input
                  type="checkbox"
                  checked={notesConfirmed}
                  onChange={(event) => setNotesConfirmed(event.target.checked)}
                />
                I understand my notes will be permanently deleted.
              </label>
            )}
            {needsTyping && (
              <label className="delete-type-confirm">
                <span>
                  Type <strong>delete</strong> to confirm
                  {dry.books >= 10 ? ` a batch of ${count(dry.books)}` : " the filtered selection"}.
                </span>
                <input
                  aria-label="Type delete to confirm"
                  value={typed}
                  autoComplete="off"
                  onChange={(event) => setTyped(event.target.value)}
                />
              </label>
            )}
          </div>
        )}
        {conflict && (
          <p className="notice delete-conflict" role="status" aria-live="polite">
            {conflict}
          </p>
        )}
        {error && (
          <div className="error delete-error" role="alert">
            <span>{error}</span>
            {!dry && (
              <button className="ghost bordered" onClick={() => void review(selection)}>
                Try again
              </button>
            )}
          </div>
        )}
        <div className="confirm-actions">
          <button ref={cancelRef} className="ghost bordered" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary danger" onClick={() => void execute()} disabled={!canDelete}>
            {busy ? "Deleting…" : books === 1 ? "Delete book" : `Delete ${plural(books, "book")}`}
          </button>
        </div>
      </div>
    </div>
  );
}
