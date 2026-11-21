const MAX_QUERY = 100;

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

function truncate(text: string): string {
  if (text.length <= MAX_QUERY) return text;
  const cut = text.slice(0, MAX_QUERY);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_QUERY / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * A book title becomes a short topic: "Deep Learning Crash Course - A Hands-On, Project-Based ..."
 * searches for "Deep Learning Crash Course". The server rejects queries over 120 characters.
 */
export function newsQueryFromTitle(title: string): string {
  const flat = clean(title);
  const head = flat.split(/\s+[-–—]\s+|:\s/)[0]?.trim() ?? "";
  return truncate(head.length >= 3 ? head : flat);
}

/** A quoted passage can be a whole paragraph; keep the beginning, cut at a word boundary. */
export function newsQueryFromQuote(quote: string): string {
  return truncate(clean(quote));
}
