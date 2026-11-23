/**
 * Stream filter for `[book:n]` markers (ADR-17). The model only knows the shortlist
 * position, never a book id; the server keeps a marker only when `n` is one of the
 * candidates it sent, records the valid ones in order of appearance and removes every
 * other `[book:…]` before the text reaches the client.
 *
 * The filter holds a possible marker between deltas (at most 16 characters) so a marker
 * split as `"[bo"` + `"ok:2]"` is validated as one unit. The pending text is flushed when
 * the stream ends.
 */

export const BOOK_MARKER_PREFIX = "[book:";
/** `[book:` + up to nine digits + `]`; longer text is not a marker. */
export const MAX_MARKER_CHARS = 16;

export interface BookMarkerFilter {
  /** Appends a provider delta and returns the text that is safe to send now. */
  push(text: string): string;
  /** Returns the pending tail at the end of the stream. */
  flush(): string;
  /** Valid markers, in order of first appearance, without repetition. */
  readonly markers: readonly number[];
}

export function createBookMarkerFilter(valid: Iterable<number>): BookMarkerFilter {
  const allowed = new Set(valid);
  const markers: number[] = [];
  const seen = new Set<number>();
  let pending = "";

  const record = (n: number): void => {
    if (seen.has(n)) return;
    seen.add(n);
    markers.push(n);
  };

  const drain = (final: boolean): string => {
    let output = "";
    for (;;) {
      const start = pending.indexOf("[");
      if (start < 0) {
        output += pending;
        pending = "";
        return output;
      }
      output += pending.slice(0, start);
      pending = pending.slice(start);
      const lower = pending.toLowerCase();
      if (lower.length < BOOK_MARKER_PREFIX.length && BOOK_MARKER_PREFIX.startsWith(lower)) {
        // A possible marker prefix; wait for the next delta unless this is the end.
        if (!final) return output;
        output += pending;
        pending = "";
        return output;
      }
      if (!lower.startsWith(BOOK_MARKER_PREFIX)) {
        // A literal bracket, for example a citation marker: emit it and keep scanning.
        output += pending[0];
        pending = pending.slice(1);
        continue;
      }
      const close = pending.indexOf("]");
      if (close < 0) {
        if (!final && pending.length < MAX_MARKER_CHARS) return output;
        if (final) {
          // An incomplete marker at the end is not a valid marker: drop it.
          pending = "";
          return output;
        }
        // Overlong text without a closing bracket: drop the prefix and rescan the rest.
        pending = pending.slice(BOOK_MARKER_PREFIX.length);
        continue;
      }
      if (close + 1 > MAX_MARKER_CHARS) {
        // A `[book:…]` run longer than any marker: remove it through its bracket.
        pending = pending.slice(close + 1);
        continue;
      }
      const marker = pending.slice(0, close + 1);
      pending = pending.slice(close + 1);
      const match = /^\[book:(\d{1,2})\]$/i.exec(marker);
      if (!match) continue;
      const n = Number(match[1]);
      if (!allowed.has(n)) continue;
      record(n);
      // Canonical form: the client only understands lowercase `[book:n]`.
      output += `[book:${n}]`;
    }
  };

  return {
    push(text: string): string {
      pending += text;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
    get markers(): readonly number[] {
      return markers;
    },
  };
}

/**
 * Removes `[book:n]` card markers from assistant text in one linear pass. Only the
 * marker and the single space immediately before it are removed; indentation, runs of
 * spaces and `[n]` numeric markers stay literal. Fenced code is not special-cased: a card
 * marker is removed wherever it appears, including inside a code block.
 */
export function stripBookMarkers(text: string): string {
  return text.replace(/ ?\[book:\d{1,3}\]/g, "");
}
