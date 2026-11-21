import "./FavoriteButton.css";

export type FavoriteButtonProps = {
  favorite: boolean;
  /** Caller owns the request (see `useFavorite`); the button only renders and emits. */
  onToggle: () => void;
  /** Adds the book title to the accessible name in grids and tables. */
  bookTitle?: string;
  /** 32 px icon-only control for cards and table rows. */
  compact?: boolean;
  /** Visible "Favorite" label next to the star; ignored when `compact`. */
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
};

/**
 * Accessible star toggle. The pressed state is exposed through `aria-pressed`; the
 * accessible name always names the action and, when available, the book. The click is
 * kept from bubbling so a star inside a card link does not navigate.
 */
export function FavoriteButton({
  favorite,
  onToggle,
  bookTitle,
  compact = false,
  showLabel = false,
  disabled = false,
  className,
}: FavoriteButtonProps) {
  const action = favorite ? "Remove from favorites" : "Add to favorites";
  const name = bookTitle === undefined ? action : `${action}: ${bookTitle}`;
  const classes = [
    "favorite-button",
    compact && "favorite-button--compact",
    showLabel && !compact && "favorite-button--label",
    className,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      aria-pressed={favorite}
      aria-label={name}
      title={name}
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <svg
        className="favorite-button-icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M12 3.4 14.6 8.7 20.4 9.5 16.2 13.6 17.2 19.4 12 16.7 6.8 19.4 7.8 13.6 3.6 9.5 9.4 8.7Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      {showLabel && !compact && <span className="favorite-button-label">Favorite</span>}
    </button>
  );
}
