/**
 * Characters per "page" for the EPUB counter. It is a constant on purpose: a page number must
 * depend only on the book, not on window size or font, or the web and desktop apps (or two
 * windows) would disagree about where page 400 is. Arrows still turn one screen at a time.
 */
export const PAGE_CHARS = 1500;

export const isRangeCfi = (value: string) => value.startsWith("epubcfi(") && value.includes(",");

type ResolvableBook = { spine: { get(cfi: string): unknown } };

/**
 * epub.js throws inside its own display queue (not as a rejected promise) when it
 * is handed a malformed CFI, which leaves the reader blank. Check it up front.
 */
export function resolvable(epub: ResolvableBook | null | undefined, cfi: string) {
  try {
    return Boolean(epub?.spine.get(cfi));
  } catch {
    return false;
  }
}
