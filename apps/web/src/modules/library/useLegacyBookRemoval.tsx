import { useCallback } from "react";
import type { ReactNode } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { Book } from "../../types";

type Ask = (options: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}) => Promise<boolean>;

/**
 * Deletion on servers that predate the bulk dry-run endpoint: a confirmation
 * dialog followed by `DELETE /api/books/:id`. Newer servers route the same
 * button through the review dialog instead.
 */
export function useLegacyBookRemoval({
  api,
  selectable,
  ask,
  requestDeleteBook,
  removeBook,
  invalidateFacets,
  onError,
  onNotice,
}: {
  api: ApiFn;
  selectable: boolean;
  ask: Ask;
  requestDeleteBook: (book: Book) => void;
  removeBook: (id: string) => void;
  invalidateFacets: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  return useCallback(
    async (book: Book) => {
      if (selectable) {
        requestDeleteBook(book);
        return;
      }
      const ok = await ask({
        title: "Delete this book?",
        message: (
          <>
            <strong>{book.title}</strong> will be removed from your library, along with its notes. This cannot be
            undone.
          </>
        ),
        confirmLabel: "Delete book",
        danger: true,
      });
      if (!ok) return;
      onError("");
      try {
        await api(`/api/books/${book.id}`, { method: "DELETE" });
        removeBook(book.id);
        invalidateFacets();
        onNotice("Book deleted.");
      } catch (e) {
        onError(formatError(e));
      }
    },
    [api, ask, invalidateFacets, onError, onNotice, removeBook, requestDeleteBook, selectable],
  );
}
