const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  laquo: "\u00ab",
  raquo: "\u00bb",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  deg: "\u00b0",
  middot: "\u00b7",
  bull: "\u2022",
  eacute: "\u00e9",
  atilde: "\u00e3",
  ccedil: "\u00e7",
  oacute: "\u00f3",
  aacute: "\u00e1",
  iacute: "\u00ed",
  uacute: "\u00fa",
  ecirc: "\u00ea",
  ocirc: "\u00f4",
  acirc: "\u00e2",
  agrave: "\u00e0",
  uuml: "\u00fc",
};

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const BLOCK_BREAK = /<\s*\/?\s*(?:p|div|h[1-6]|li|tr|blockquote|section|article|table|figcaption|header|footer|pre|ul|ol)\b[^>]*>/gi;

/**
 * Converts chapter markup to plain text. Everything is treated as untrusted:
 * script-like containers are dropped, tags are stripped and entities decoded,
 * so the result is safe to store and to display without HTML rendering.
 */
export function htmlToText(html: string): string {
  const withoutContainers = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\s*(?:br|hr)\s*\/?>/gi, "\n")
    .replace(BLOCK_BREAK, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutContainers)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
