import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Library } from "../../use-cases/Library.js";
import type { Book } from "../../ports/index.js";

const NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
const MIME = { epub: "application/epub+zip", pdf: "application/pdf" } as const;
const PAGE_SIZE = 100;

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function link(rel: string, href: string, type: string): string {
  return `<link rel="${xml(rel)}" href="${xml(href)}" type="${xml(type)}"/>`;
}

function feed(title: string, path: string, type: string, entries: string, updated: string, paging = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
<id>${xml(path)}</id><title>${xml(title)}</title><updated>${updated}</updated>
<author><name>Knowlify</name></author>
${link("self", path, type)}${link("start", "/opds/", NAV)}
${link("search", "/opds/search.xml", "application/opensearchdescription+xml")}
${paging}${entries}</feed>`;
}

/** Keeps page=1 out of URLs; clients that never send `page` see the pre-pagination path. */
function feedPath(route: string, q: string, page: number): string {
  const params = [q ? `q=${encodeURIComponent(q)}` : "", page > 1 ? `page=${page}` : ""].filter(Boolean);
  return `/opds${route}${params.length ? `?${params.join("&")}` : ""}`;
}

function entryFor(book: Book): string {
  const path = `/api/books/${encodeURIComponent(book.id)}`;
  const coverType = extname(book.cover_path ?? "").toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  return `<entry><id>urn:knowlify:book:${xml(encodeURIComponent(book.id))}</id><title>${xml(book.title)}</title>
<updated>${new Date(book.added_at).toISOString()}</updated><author><name>${xml(book.author)}</name></author>
${link("http://opds-spec.org/acquisition", `${path}/file`, MIME[book.format])}
${book.cover_path ? link("http://opds-spec.org/image", `${path}/cover`, coverType) + link("http://opds-spec.org/image/thumbnail", `${path}/cover`, coverType) : ""}</entry>`;
}

export async function opdsRoutes(app: FastifyInstance, opts: { library: Library }) {
  const { library } = opts;
  app.get("/", async (_req, reply) => {
    const updated = new Date().toISOString();
    const entries = [["All books", "/opds/books"], ["Recent", "/opds/recent"]]
      .map(([title, path]) => `<entry><id>${path}</id><title>${title}</title><updated>${updated}</updated>${link("subsection", path, ACQ)}</entry>`)
      .join("");
    return reply.type(NAV).send(feed("Knowlify", "/opds/", NAV, entries, updated));
  });

  for (const route of ["/books", "/search"]) {
    app.get<{ Querystring: { q?: string; page?: number } }>(route, {
      schema: {
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            page: { type: "integer", minimum: 1, maximum: 1_000_000, default: 1 },
          },
        },
      },
    }, async (req, reply) => {
      const q = req.query.q ?? "";
      const page = req.query.page ?? 1;
      const books = library.catalogPage(q, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
      const hasNext = books.length > PAGE_SIZE;
      const visible = hasNext ? books.slice(0, PAGE_SIZE) : books;
      const updated = new Date(Math.max(0, ...visible.map((book) => book.added_at))).toISOString();
      const entries = visible.map(entryFor).join("");
      const paging = [
        page > 1 ? link("previous", feedPath(route, q, page - 1), ACQ) : "",
        hasNext ? link("next", feedPath(route, q, page + 1), ACQ) : "",
      ].filter(Boolean).map((value) => `${value}\n`).join("");
      const path = feedPath(route, q, page);
      return reply.type(ACQ).send(feed(q ? `Search: ${q}` : "All books", path, ACQ, entries, updated, paging));
    });
  }

  app.get<{ Querystring: { q?: string } }>("/recent", {
    schema: { querystring: { type: "object", properties: { q: { type: "string" } } } },
  }, async (req, reply) => {
    const q = req.query.q ?? "";
    const books = library.catalog(q, true);
    const updated = new Date(Math.max(0, ...books.map((book) => book.added_at))).toISOString();
    const entries = books.map(entryFor).join("");
    const path = `/opds/recent${q ? `?q=${encodeURIComponent(q)}` : ""}`;
    return reply.type(ACQ).send(feed(q ? `Search: ${q}` : "Recent", path, ACQ, entries, updated));
  });

  app.get("/search.xml", async (_req, reply) => reply.type("application/opensearchdescription+xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>Knowlify</ShortName><Description>Search books by title or author</Description>
<Url type="${xml(ACQ)}" template="/opds/search?q={searchTerms}"/>
<InputEncoding>UTF-8</InputEncoding></OpenSearchDescription>`,
  ));
}
