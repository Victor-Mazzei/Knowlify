import { uiCount } from "./format";
import "./selection.css";

export function SelectionBar({
  count,
  total,
  loadedCount,
  allMode,
  busy = false,
  favoriteBusy = false,
  onSelectAll,
  onTag,
  onFavorite,
  onDelete,
  onClear,
}: {
  count: number;
  total: number;
  loadedCount: number;
  allMode: boolean;
  busy?: boolean;
  favoriteBusy?: boolean;
  onSelectAll: () => void;
  onTag?: () => void;
  onFavorite?: (favorite: boolean) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const showAll = !allMode && total > loadedCount;
  const label = allMode ? `All ${uiCount(total)} results selected` : `${uiCount(count)} selected`;
  const blocked = busy || favoriteBusy;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection actions">
      <div className="selection-summary">
        <strong className="selection-count">{label}</strong>
        {showAll && (
          <span className="selection-hint">
            {uiCount(count)} selected on this page.{" "}
            <button type="button" className="selection-link" onClick={onSelectAll}>
              Select all {uiCount(total)} results
            </button>
          </span>
        )}
        {allMode && <span className="selection-hint">Actions apply to every matching book.</span>}
      </div>
      <div className="selection-actions">
        {onTag && (
          <button type="button" className="ghost bordered" onClick={onTag} disabled={blocked}>
            Tag
          </button>
        )}
        {onFavorite && (
          <>
            <button
              type="button"
              className="ghost bordered"
              title="Add the selected books to favorites"
              onClick={() => onFavorite(true)}
              disabled={blocked}
            >
              Favorite
            </button>
            <button
              type="button"
              className="ghost bordered"
              title="Remove the selected books from favorites"
              onClick={() => onFavorite(false)}
              disabled={blocked}
            >
              Unfavorite
            </button>
          </>
        )}
        <button type="button" className="ghost bordered danger-action" onClick={onDelete} disabled={blocked}>
          Delete
        </button>
        <button type="button" className="ghost selection-clear" onClick={onClear} disabled={blocked}>
          Clear
        </button>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {label}
      </p>
    </div>
  );
}
