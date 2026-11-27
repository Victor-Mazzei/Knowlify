import type { CSSProperties } from "react";

/**
 * Height-only compaction: a low desktop needs the same compact chrome as a
 * phone. Width is deliberately absent so 1280x600 does not keep the tall
 * header, rail and composer.
 */
export const COMPACT_TUTOR_QUERY = "(max-height: 620px)";

/** The app bar also collapses on narrow phones, where its wrapped header is tall. */
export const COMPACT_HEADER_QUERY = "(max-width: 520px), (max-height: 620px)";

/** The transcript never collapses below a useful height. */
export const MIN_TRANSCRIPT_HEIGHT = "7.5rem";

/** Preferred transcript height on a roomy page; it may shrink to the floor above. */
export const TRANSCRIPT_BASIS = "max(7.5rem, 25dvh)";

/**
 * Desktop shell reserve for the injected "Connection settings" button:
 * 1.75em covers its line box with slack (the button inherits the body font and
 * grows with it), 46px covers bottom offset + padding/border + gap + slack, and
 * the safe-area inset is added on top. Relative units keep zoom and larger root
 * fonts from eating the reserve.
 */
export const DESKTOP_CONNECTION_RESERVE =
  "calc(1.75em + 46px + env(safe-area-inset-bottom))";

export const TRANSCRIPT_STYLE = {
  "--tutor-min-thread": MIN_TRANSCRIPT_HEIGHT,
  "--tutor-thread-basis": TRANSCRIPT_BASIS,
} as CSSProperties;

export const DESKTOP_RESERVE_STYLE = {
  "--desktop-connection-reserve": DESKTOP_CONNECTION_RESERVE,
} as CSSProperties;
