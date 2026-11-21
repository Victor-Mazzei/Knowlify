import type { ApiFn } from "../../components/dialogs";
import type { Book, BookSelection, DeleteResult, Tag, TagWithCount } from "../../types";
import { DeleteBooksDialog } from "./DeleteBooksDialog";
import type { DeleteProgress } from "./deleteBooksApi";
import { SelectionBar } from "./selection/SelectionBar";
import type { Selection } from "./selection/useSelection";
import { TagPopover } from "./TagPopover";

/** Selection toolbar, tag popover and delete dialog, kept out of the page composition. */
export function LibrarySelection({
  selectable,
  selection,
  books,
  total,
  tags,
  tagsLoading,
  tagOpen,
  deleteTarget,
  api,
  favoriteBusy,
  onSelectAll,
  onToggleTag,
  onFavorite,
  onDelete,
  onClear,
  onApplyTags,
  onCreateTag,
  onDeleted,
  onPartial,
  onCloseTag,
  onCloseDelete,
}: {
  selectable: boolean;
  selection: Selection;
  books: Book[];
  total: number;
  tags: TagWithCount[];
  tagsLoading: boolean;
  tagOpen: boolean;
  deleteTarget: BookSelection | null;
  api: ApiFn;
  favoriteBusy: boolean;
  onSelectAll: () => void;
  onToggleTag: () => void;
  onFavorite: (favorite: boolean) => void;
  onDelete: () => void;
  onClear: () => void;
  onApplyTags: (add: string[], remove: string[]) => Promise<void>;
  onCreateTag: (name: string) => Promise<Tag>;
  onDeleted: (result: DeleteResult, target: BookSelection) => void;
  onPartial: (progress: DeleteProgress) => void;
  onCloseTag: () => void;
  onCloseDelete: () => void;
}) {
  return (
    <>
      {selectable && selection.count > 0 && (
        <SelectionBar
          count={selection.count}
          total={total}
          loadedCount={books.length}
          allMode={selection.all !== null}
          favoriteBusy={favoriteBusy}
          onSelectAll={onSelectAll}
          onTag={onToggleTag}
          onFavorite={onFavorite}
          onDelete={onDelete}
          onClear={onClear}
        />
      )}
      {selectable && tagOpen && selection.count > 0 && (
        <TagPopover
          tags={tags}
          loading={tagsLoading}
          selectedBooks={books.filter((book) => selection.isSelected(book.id))}
          allMode={selection.all !== null}
          onApply={onApplyTags}
          onCreate={onCreateTag}
          onClose={onCloseTag}
        />
      )}
      {deleteTarget && (
        <DeleteBooksDialog
          api={api}
          selection={deleteTarget}
          onDeleted={onDeleted}
          onPartial={onPartial}
          onClose={onCloseDelete}
        />
      )}
    </>
  );
}
