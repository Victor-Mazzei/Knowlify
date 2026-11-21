/**
 * Third-party text sanitization for metadata candidates (ADR-5). Provider descriptions
 * are HTML; the UI renders plain text, so tags/scripts/styles are removed here, entities
 * decoded and control characters dropped. Truncation is applied after sanitization so a
 * tag never eats the visible character budget.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    if (named !== undefined) return named;
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Reject invalid code points and lone surrogates instead of crashing fromCodePoint.
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return "";
      }
      return String.fromCodePoint(code);
    }
    return match;
  });
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Converts provider HTML to plain text and enforces the field limit. `multiline` keeps
 * paragraph/line breaks (descriptions); titles and names become one line.
 */
export function htmlText(value: unknown, maxChars: number, multiline = false): string | null {
  if (typeof value !== "string") return null;
  let text = value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  text = decodeEntities(text).normalize("NFC").replace(/\r\n?/g, "\n");
  text = text.replace(CONTROL, " ");
  text = multiline
    ? text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ");
  text = text.trim();
  if (text.length > maxChars) {
    // Do not cut a surrogate pair in half.
    const end = /[\uD800-\uDBFF]/.test(text[maxChars - 1] ?? "") ? maxChars - 1 : maxChars;
    text = text.slice(0, end).trim();
  }
  return text.length === 0 ? null : text;
}

/** Keeps only an HTTPS link on one of the known provider hosts; anything else becomes null. */
export function providerLink(value: unknown, hosts: readonly string[]): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.port !== "" && url.port !== "443") return null;
    const host = url.hostname.toLowerCase();
    if (!hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}
