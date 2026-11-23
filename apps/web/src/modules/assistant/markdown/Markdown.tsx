import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components, ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookChip, CitationChip } from "../MarkerChips";
import { isDesktopShell } from "../../../services/desktop";
import type { Citation, RecommendedBook } from "../types";
import { canonicalLanguage, languageLabel } from "./languages";
import {
  createMarkerPlugin,
  MARKER_KIND_PROPERTY,
  MARKER_NUMBER_PROPERTY,
  remarkSoftBreaks,
} from "./plugins";
import type { MarkerKind } from "./plugins";
import { normalizeStreamingMarkdown } from "./streaming";
import type { HighlightToken } from "./highlight";
import "./markdown.css";

const SAFE_PROTOCOL = /^(https?|mailto):/i;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const LANGUAGE_CLASS = /(?:^|\s)language-([^\s]+)/;

type MarkdownContextValue = {
  citations: ReadonlyMap<number, Citation>;
  books: ReadonlyMap<number, RecommendedBook>;
  onOpenBook?: () => void;
  unclosedCodeText: string | null;
};

const MarkdownContext = createContext<MarkdownContextValue>({
  citations: new Map(),
  books: new Map(),
  unclosedCodeText: null,
});

/** Plain text of a link label, including labels with emphasis inside. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function textLink(children: ReactNode) {
  return <span className="md-link-text">{children}</span>;
}

type AnchorProps = ComponentPropsWithoutRef<"a"> & ExtraProps;
type ImageProps = ComponentPropsWithoutRef<"img"> & ExtraProps;
type PreProps = ComponentPropsWithoutRef<"pre"> & ExtraProps;
type TableProps = ComponentPropsWithoutRef<"table"> & ExtraProps;
type CellProps = ComponentPropsWithoutRef<"th"> & ExtraProps;
type HeadingProps = ComponentPropsWithoutRef<"h1"> & ExtraProps;

type Marker = { kind: MarkerKind; number: number };

/**
 * Only links built by createMarkerPlugin carry these properties. Arbitrary
 * Markdown cannot attach properties to a link node (raw HTML is rendered as
 * text), so this is the authenticity check that stops model-written links from
 * forging chips by copying a citation or book href.
 */
function markerOf(node: AnchorProps["node"]): Marker | null {
  const properties = node?.properties;
  const kind = properties?.[MARKER_KIND_PROPERTY];
  const number = properties?.[MARKER_NUMBER_PROPERTY];
  if (kind !== "citation" && kind !== "book") return null;
  if (typeof number !== "number" || !Number.isInteger(number)) return null;
  return { kind, number };
}

/**
 * Links are the only clickable Markdown construct. Citation and book chips
 * come only from links authenticated by the marker plugin; every other link,
 * including one whose href copies a marker URL, follows the normal protocol
 * rules. Only http(s) and mailto survive; anything else (javascript:, data:,
 * vbscript:, file:, relative URLs) becomes text. External links open in a new
 * tab with noopener/noreferrer/nofollow, and show their host when the label
 * does not already name it. In the desktop shell the existing bootstrap bridge
 * opens http(s) links in the system browser; mailto has no safe bridge there,
 * so it is shown as text.
 */
function MarkdownLink({ href, title, children, node, ...rest }: AnchorProps) {
  const { citations, books, onOpenBook } = useContext(MarkdownContext);
  const raw = href?.trim() ?? "";
  const marker = markerOf(node);

  if (marker?.kind === "citation") {
    const citation = citations.get(marker.number);
    return citation ? <CitationChip citation={citation} /> : textLink(children);
  }
  if (marker?.kind === "book") {
    const book = books.get(marker.number);
    return book ? <BookChip book={book} onOpenBook={onOpenBook} /> : textLink(children);
  }

  if (!raw || CONTROL_CHARACTERS.test(raw) || !SAFE_PROTOCOL.test(raw)) {
    return textLink(children);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return textLink(children);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") {
    return textLink(children);
  }

  // The desktop bridge opens https in the system browser but rejects mailto
  // and public http. Show those as text there instead of a dead click; the web
  // app keeps normal links.
  if (isDesktopShell() && (protocol === "mailto:" || protocol === "http:")) {
    return (
      <span className="md-link-text">
        {children} <span className="md-link-host">({parsed.href})</span>
      </span>
    );
  }

  const label = textOf(children).trim();
  const host =
    protocol === "mailto:"
      ? parsed.pathname.replace(/^\/+/, "")
      : parsed.hostname.replace(/^www\./i, "");
  const showHost =
    Boolean(host) &&
    label !== host &&
    label !== parsed.hostname &&
    label !== parsed.href &&
    label !== raw;

  return (
    <a
      {...rest}
      className="md-link"
      href={parsed.href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={title ? `${title} — ${parsed.href}` : parsed.href}
    >
      {label ? children : host}
      {showHost ? <span className="md-link-host"> ({host})</span> : null}
    </a>
  );
}

/**
 * Markdown images never load: an image URL is an outbound request that could
 * carry data. The alt text and URL are shown as text instead.
 */
function MarkdownImage({ src, alt, title, node: _node }: ImageProps) {
  const label = alt?.trim();
  return (
    <span className="md-image-blocked">
      <span className="md-image-label">Image:</span> {label || "no description"}
      {src ? <span className="md-image-src">{src}</span> : null}
      {title ? <span className="md-image-title">{title}</span> : null}
    </span>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

function CodeBlock({ children, node: _node, ...rest }: PreProps) {
  const codeElement = Children.toArray(children).find((child) =>
    isValidElement<{ className?: string; children?: ReactNode }>(child),
  ) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;

  if (!codeElement) {
    return (
      <pre {...rest} className="md-pre md-code-pre">
        {children}
      </pre>
    );
  }

  return (
    <CodeBlockBody
      code={textOf(codeElement.props.children).replace(/\n$/, "")}
      language={LANGUAGE_CLASS.exec(codeElement.props.className ?? "")?.[1] ?? null}
      preProps={rest}
    />
  );
}

function CodeBlockBody({
  code,
  language,
  preProps,
}: {
  code: string;
  language: string | null;
  preProps: ComponentPropsWithoutRef<"pre">;
}) {
  const { unclosedCodeText } = useContext(MarkdownContext);
  const canonical = canonicalLanguage(language);
  const label = languageLabel(language);
  const open = unclosedCodeText !== null && code.trim() === unclosedCodeText.trim();

  const [tokens, setTokens] = useState<HighlightToken[] | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    setTokens(null);
    if (!canonical || open || !code) return;
    let cancelled = false;
    import("./highlight")
      .then((module) => module.highlightCode(code, canonical))
      .then((highlighted) => {
        if (!cancelled) setTokens(highlighted);
      })
      .catch(() => {
        // A failed chunk load keeps the readable, unhighlighted code.
        if (!cancelled) setTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canonical, code, open]);

  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(""), 2000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  const copy = () => {
    copyToClipboard(code)
      .then(() => setAnnouncement("Copied"))
      .catch(() => setAnnouncement("Copy failed"));
  };

  const copyLabel = label === "Code" ? "Copy code" : `Copy ${label} code`;
  const blockLabel = label === "Code" ? "Code block" : `${label} code block`;

  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{label}</span>
        <button type="button" className="md-code-copy" onClick={copy} aria-label={copyLabel}>
          Copy
        </button>
      </div>
      <pre {...preProps} className="md-code-pre" tabIndex={0} aria-label={blockLabel}>
        <code className="md-code-body">
          {tokens
            ? tokens.map((token, index) =>
                token.className ? (
                  <span key={index} className={token.className}>
                    {token.text}
                  </span>
                ) : (
                  token.text
                ),
              )
            : code}
        </code>
      </pre>
      <span className="md-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

function MarkdownTable({ children, node: _node, ...rest }: TableProps) {
  return (
    <div className="md-table-wrap" role="region" aria-label="Table" tabIndex={0}>
      <table {...rest} className="md-table">
        {children}
      </table>
    </div>
  );
}

function MarkdownHeaderCell({ children, node: _node, ...rest }: CellProps) {
  return (
    <th {...rest} scope="col">
      {children}
    </th>
  );
}

function heading(source: 1 | 2 | 3 | 4 | 5 | 6, tag: "h3" | "h4" | "h5" | "h6") {
  return function MarkdownHeading({ children, node: _node, ...rest }: HeadingProps) {
    const Tag = tag;
    return (
      <Tag {...rest} className={`md-heading md-h${source}`}>
        {children}
      </Tag>
    );
  };
}

const components: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: CodeBlock,
  table: MarkdownTable,
  th: MarkdownHeaderCell,
  // Answers sit under the page/drawer title, so source h1 starts at h3.
  h1: heading(1, "h3"),
  h2: heading(2, "h4"),
  h3: heading(3, "h5"),
  h4: heading(4, "h6"),
  h5: heading(5, "h6"),
  h6: heading(6, "h6"),
};

export type MarkdownMessageProps = {
  text: string;
  citations: Citation[] | null;
  books?: RecommendedBook[];
  onOpenBook?: () => void;
  partial?: boolean;
};

export const MarkdownMessage = memo(function MarkdownMessage({
  text,
  citations,
  books,
  onOpenBook,
  partial = false,
}: MarkdownMessageProps) {
  const normalized = useMemo(() => normalizeStreamingMarkdown(text, partial), [partial, text]);
  const citationMap = useMemo(
    () => new Map((citations ?? []).map((citation) => [citation.n, citation])),
    [citations],
  );
  const bookMap = useMemo(() => new Map((books ?? []).map((book) => [book.n, book])), [books]);
  const remarkPlugins = useMemo(
    () => [remarkGfm, createMarkerPlugin(citations, books), remarkSoftBreaks],
    [books, citations],
  );
  const context = useMemo(
    () => ({ citations: citationMap, books: bookMap, onOpenBook, unclosedCodeText: normalized.unclosedCodeText }),
    [bookMap, citationMap, normalized.unclosedCodeText, onOpenBook],
  );

  return (
    <MarkdownContext.Provider value={context}>
      <div className="asst-answer md">
        <Markdown remarkPlugins={remarkPlugins} components={components} skipHtml={false}>
          {normalized.text}
        </Markdown>
      </div>
    </MarkdownContext.Provider>
  );
});
