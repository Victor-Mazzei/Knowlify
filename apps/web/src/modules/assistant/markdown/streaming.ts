/**
 * Makes partial Markdown safe to render while an answer streams.
 *
 * A model can stop in the middle of `**bold`, a fenced block or an inline code
 * span. Rendering those raw makes the text jump between literal markers and
 * formatted text. Closing the pending construct for display (never for storage)
 * keeps each delta visually stable. The normalizer only closes what it can
 * recognize; tables, links and split markers keep their normal Markdown
 * behavior until the rest arrives.
 */

export type NormalizedMarkdown = {
  text: string;
  /** A fenced code block is still open at the end of the text. */
  unclosedCodeBlock: boolean;
  /** Content of that block, used to keep it unhighlighted until it closes. */
  unclosedCodeText: string | null;
  unclosedCodeLanguage: string | null;
};

type Fence = { marker: "`" | "~"; length: number; language: string | null };

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const WHITESPACE = /\s/;
const PUNCTUATION = /\p{P}/u;
const WORD = /[\p{L}\p{N}]/u;
const SAFE_LANGUAGE = /^[a-z0-9+#.-]{1,24}$/i;

function closingFence(marker: "`" | "~", length: number): RegExp {
  return new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${length},}\\s*$`);
}

function fenceLanguage(info: string): string | null {
  const first = info.trim().split(/\s+/, 1)[0];
  return first && SAFE_LANGUAGE.test(first) ? first : null;
}

/**
 * Reads the source once, keeping the prose outside fenced blocks and the
 * content of a block that never closed.
 */
function scanFences(source: string) {
  const lines = source.split("\n");
  const prose: string[] = [];
  let fence: Fence | null = null;
  let openContent: string[] = [];

  for (const line of lines) {
    const clean = line.replace(/\r$/, "");
    if (!fence) {
      const opened = OPEN_FENCE.exec(clean);
      if (opened) {
        fence = {
          marker: opened[1][0] as "`" | "~",
          length: opened[1].length,
          language: fenceLanguage(opened[2]),
        };
        openContent = [];
      } else {
        prose.push(clean);
      }
      continue;
    }

    if (closingFence(fence.marker, fence.length).test(clean)) {
      fence = null;
      continue;
    }
    openContent.push(clean);
  }

  return { fence, openContent, prose };
}

type Delimiter = { char: "*" | "_" | "~"; length: number };

function isWord(char: string | undefined): boolean {
  return Boolean(char && WORD.test(char));
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || char === "\n" || WHITESPACE.test(char);
}

function isPunctuation(char: string | undefined): boolean {
  return Boolean(char && PUNCTUATION.test(char));
}

/**
 * Collects the emphasis delimiters that never got a closing run and the length
 * of an open backtick span. The scan is deliberately conservative: a delimiter
 * only opens when the next character is a letter or digit, so `*.ts`, `* item`
 * and `**` alone stay literal.
 */
function pendingInline(prose: string): { backticks: number | null; delimiters: Delimiter[] } {
  const delimiters: Delimiter[] = [];
  let backticks: number | null = null;
  let index = 0;

  while (index < prose.length) {
    const char = prose[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === "`") {
      let run = 1;
      while (prose[index + run] === "`") run += 1;
      if (backticks === null) backticks = run;
      else if (backticks === run) backticks = null;
      index += run;
      continue;
    }

    if (backticks !== null) {
      index += 1;
      continue;
    }

    if (char !== "*" && char !== "_" && char !== "~") {
      index += 1;
      continue;
    }

    let run = 1;
    while (prose[index + run] === char) run += 1;
    if (char === "~" && run < 2) {
      index += run;
      continue;
    }

    const length = char === "~" ? 2 : Math.min(run, 3);
    const previous = index === 0 ? "\n" : prose[index - 1];
    const next = prose[index + run];
    const lineStart = index === 0 || previous === "\n";
    let thematicBreak = false;
    if (run >= 3) {
      const start = prose.lastIndexOf("\n", index - 1) + 1;
      const end = prose.indexOf("\n", index);
      const line = prose.slice(start, end === -1 ? undefined : end);
      thematicBreak = line.trim().replace(/[ \t]/g, "") === char.repeat(run);
    }

    // A bullet or a thematic break is not emphasis, and neither is an
    // intraword underscore (`snake_case`).
    if (lineStart && (char === "*" || char === "_") && isSpace(next)) {
      index += run;
      continue;
    }
    if (thematicBreak || (char === "_" && isWord(previous) && isWord(next))) {
      index += run;
      continue;
    }

    const leftFlanking = !isSpace(next) && (!isPunctuation(next) || isSpace(previous) || isPunctuation(previous));
    const rightFlanking = !isSpace(previous) && (!isPunctuation(previous) || isSpace(next) || isPunctuation(next));
    const canOpen =
      leftFlanking &&
      isWord(next) &&
      (char !== "_" || !rightFlanking || isPunctuation(previous));
    const canClose =
      rightFlanking && (char !== "_" || !leftFlanking || isPunctuation(next));

    if (canClose) {
      let match = -1;
      for (let cursor = delimiters.length - 1; cursor >= 0; cursor -= 1) {
        if (delimiters[cursor].char === char && delimiters[cursor].length === length) {
          match = cursor;
          break;
        }
      }
      if (match !== -1) {
        delimiters.splice(match, 1);
        index += run;
        continue;
      }
    }

    if (canOpen) {
      delimiters.push({ char, length });
    }
    index += run;
  }

  return { backticks, delimiters };
}

/** Inserts the closers before trailing whitespace so they stay on the last line. */
function closePending(text: string, closers: string): string {
  if (!closers) return text;
  const trailing = /\s*$/.exec(text)?.[0] ?? "";
  return `${text.slice(0, text.length - trailing.length)}${closers}${trailing}`;
}

/** Splits a table row on unescaped pipes without a lookbehind (older WebViews). */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of row) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * A table header alone is parsed as a paragraph until its delimiter row
 * arrives, which makes the answer jump. While streaming, a standalone header
 * line gets a placeholder delimiter row; the real one replaces it without a
 * layout change. Only a two-column-or-more line at the start of its block
 * qualifies, so ordinary prose that happens to contain pipes is left alone.
 */
function partialTable(source: string, prose: string[]): string | null {
  const lines = source.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last -= 1;
  if (last < 0) return null;

  const line = lines[last].trim();
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  if (last > 0 && lines[last - 1].trim() !== "") return null;

  const proseLast = [...prose].reverse().find((item) => item.trim() !== "");
  if (proseLast?.trim() !== line) return null;

  const cells = tableCells(line.slice(1, -1));
  if (cells.length < 2 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;

  const delimiter = `| ${cells.map(() => "---").join(" | ")} |`;
  const trailing = /\s*$/.exec(source)?.[0] ?? "";
  const body = source.slice(0, source.length - trailing.length);
  return `${body}\n${delimiter}${trailing}`;
}

export function normalizeStreamingMarkdown(source: string, partial: boolean): NormalizedMarkdown {
  const { fence, openContent, prose } = scanFences(source);

  if (fence) {
    // The code renderer strips one trailing newline; compare like with like.
    const unclosedCodeText = openContent.join("\n").replace(/\n$/, "");
    // A closed fence is what lets the highlighter run; while it is open the
    // renderer shows plain monospace, so appending the closer is display-only.
    const text = partial
      ? `${source}${source.endsWith("\n") ? "" : "\n"}${fence.marker.repeat(fence.length)}`
      : source;
    return {
      text,
      unclosedCodeBlock: true,
      unclosedCodeText,
      unclosedCodeLanguage: fence.language,
    };
  }

  if (!partial) {
    return { text: source, unclosedCodeBlock: false, unclosedCodeText: null, unclosedCodeLanguage: null };
  }

  const { backticks, delimiters } = pendingInline(prose.join("\n"));
  const closers = [
    ...(backticks === null ? [] : ["`".repeat(backticks)]),
    ...delimiters
      .slice()
      .reverse()
      .map((delimiter) => delimiter.char.repeat(delimiter.length)),
  ].join("");

  // Do not combine the two normalizations: a closer belongs to the header line,
  // while the placeholder delimiter belongs after it.
  const table = closers ? null : partialTable(source, prose);

  return {
    text: table ?? closePending(source, closers),
    unclosedCodeBlock: false,
    unclosedCodeText: null,
    unclosedCodeLanguage: null,
  };
}
