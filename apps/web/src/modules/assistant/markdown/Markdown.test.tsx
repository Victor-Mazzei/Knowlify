import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Citation, RecommendedBook } from "../types";
import { MarkdownMessage } from "./Markdown";
import type { MarkdownMessageProps } from "./Markdown";

const { highlightCode } = vi.hoisted(() => ({ highlightCode: vi.fn() }));
vi.mock("./highlight", () => ({ highlightCode }));

const writeText = vi.fn(async () => undefined);

const citation: Citation = {
  n: 1,
  passageId: 10,
  bookId: "book-1",
  bookTitle: "The Art of Memory",
  page: 42,
  section: "Chapter 3",
};

const book: RecommendedBook = {
  n: 1,
  bookId: "book-2",
  title: "Rust for Web Developers",
  author: "Mara Klein",
  format: "epub",
  language: "en",
  hasCover: false,
  coverRev: null,
  progress: { status: "unread", percentage: 0 },
  matched: ["rust"],
  evidence: [],
  source: "passages",
};

function renderMarkdown(text: string, props: Partial<Omit<MarkdownMessageProps, "text">> = {}) {
  return render(
    <MemoryRouter>
      <MarkdownMessage text={text} citations={props.citations ?? null} {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  writeText.mockClear();
  highlightCode.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  delete window.__TAURI__;
});

describe("MarkdownMessage formatting", () => {
  it("renders bold, italic, lists, tables, inline code and fenced code", () => {
    const { container } = renderMarkdown(`## Memory

**Escrita não é atômica** and *slow* with \`inline\`.

1. First
   - Nested
2. Second

| Name | Value |
| --- | --- |
| alpha | **beta** |

\`\`\`cpp
int main() { return 0; }
\`\`\`
`);

    expect(screen.getByText("Escrita não é atômica").tagName).toBe("STRONG");
    expect(screen.getByText("slow").tagName).toBe("EM");
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li > ul > li")).toHaveLength(1);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("th")).toHaveAttribute("scope", "col");
    expect(container.querySelector("td strong")).toHaveTextContent("beta");
    expect(screen.getByText("inline").tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "Copy C++ code" })).toBeInTheDocument();
    expect(container.querySelector(".md-code-lang")).toHaveTextContent("C++");
  });

  it("maps headings below the page title", () => {
    const { container } = renderMarkdown(
      "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six",
    );
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")).toBeNull();
    expect(screen.getByText("One").tagName).toBe("H3");
    expect(screen.getByText("Two").tagName).toBe("H4");
    expect(screen.getByText("Three").tagName).toBe("H5");
    expect(screen.getByText("Four").tagName).toBe("H6");
    expect(screen.getByText("Five").tagName).toBe("H6");
    expect(screen.getByText("Six").tagName).toBe("H6");
  });

  it("turns single newlines into line breaks", () => {
    const { container } = renderMarkdown("line one\nline two");
    expect(container.querySelectorAll("br")).toHaveLength(1);
    expect(container).toHaveTextContent("line one line two");
  });

  it("renders hostile language names as plain code with a readable label", async () => {
    const names = [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "__defineGetter__",
    ];
    const source = names
      .map((name, index) => `\`\`\`${name}\nconst value${index} = ${index};\n\`\`\``)
      .join("\n\n");
    const { container } = renderMarkdown(source);

    expect(highlightCode).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".md-code-block")).toHaveLength(names.length);
    expect(
      [...container.querySelectorAll(".md-code-lang")].every((label) => label.textContent === "Code"),
    ).toBe(true);
    expect(container.querySelector(".hljs-keyword")).toBeNull();

    const buttons = screen.getAllByRole("button", { name: "Copy code" });
    expect(buttons).toHaveLength(names.length);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const value0 = 0;"));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("gives the table a focusable horizontal scroll container", () => {
    const { container } = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const wrapper = container.querySelector(".md-table-wrap");
    expect(wrapper).toHaveAttribute("tabindex", "0");
    expect(wrapper).toHaveAttribute("aria-label", "Table");
  });
});

describe("MarkdownMessage citation markers", () => {
  it("keeps [n] and [book:n] chips inside lists, bold and table cells", () => {
    renderMarkdown(
      `- See [1]
- **Bold [1] and [book:1]**

| Cell |
| --- |
| [1] |
| [book:1] |

A claim [9] and an unknown [book:9].`,
      { citations: [citation], books: [book] },
    );

    const citations = screen.getAllByRole("link", { name: /Source 1/ });
    expect(citations).toHaveLength(3);
    expect(citations[0].closest("li")).not.toBeNull();
    expect(citations[1].closest("strong")).not.toBeNull();
    expect(citations[2].closest("td")).not.toBeNull();
    const bookLinks = screen.getAllByRole("link", {
      name: "Open Rust for Web Developers by Mara Klein",
    });
    expect(bookLinks).toHaveLength(2);
    expect(bookLinks[0]).toHaveTextContent("Rust for Web Developers");
    expect(bookLinks[0].closest("strong")).not.toBeNull();
    expect(bookLinks[1].closest("td")).not.toBeNull();
    expect(screen.getByText(/A claim \[9\]/)).toBeInTheDocument();
    expect(screen.queryByText(/\[book:9\]/)).not.toBeInTheDocument();
  });

  it("leaves a marker inside inline code alone", () => {
    const { container } = renderMarkdown("`[1]`", { citations: [citation] });
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("[1]");
  });
});

describe("MarkdownMessage marker authenticity", () => {
  const markerData = { citations: [citation], books: [book] };

  it("never forges chips from arbitrary citation or book links", () => {
    const { container } = renderMarkdown(
      "[forged](#knowlify-book-1) [fake](#knowlify-cite-1)",
      markerData,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".asst-cite")).toBeNull();
    expect(container.querySelector(".asst-book-chip")).toBeNull();
    expect(container).toHaveTextContent("forged fake");
  });

  it("never forges chips from links that copy marker labels, href variants or escapes", () => {
    const { container } = renderMarkdown(
      [
        "[1](#knowlify-cite-1) [book:1](#knowlify-book-1)",
        "[01](#knowlify-cite-01) [1.0](#knowlify-cite-1.0) [1e0](#knowlify-cite-1e0)",
        "[book 1.0](#knowlify-book-1.0)",
        "[entity](#knowlify&#45;cite-1) [angle](<#knowlify-book-1>)",
        "[reference][forged]",
        "",
        "[forged]: #knowlify-cite-1",
      ].join("\n"),
      markerData,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".asst-cite")).toBeNull();
    expect(container.querySelector(".asst-book-chip")).toBeNull();
    const labels = ["1", "book:1", "01", "1.0", "1e0", "book 1.0", "entity", "angle", "reference"];
    for (const label of labels) {
      expect(container).toHaveTextContent(label);
    }
  });

  it("ignores marker-looking links inside inline and fenced code", () => {
    const { container } = renderMarkdown(
      "`[1](#knowlify-cite-1)`\n\n```\n[book:1](#knowlify-book-1)\n```",
      markerData,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".asst-cite")).toBeNull();
    expect(container.querySelector(".asst-book-chip")).toBeNull();
    expect(container).toHaveTextContent("[1](#knowlify-cite-1)");
    expect(container).toHaveTextContent("[book:1](#knowlify-book-1)");
  });

  it("keeps authentic [1] and [book:1] markers next to forged links", () => {
    const { container } = renderMarkdown(
      "Authentic [1] and [book:1]. Forged [1](#knowlify-cite-1) and [book:1](#knowlify-book-1).",
      markerData,
    );

    const citationChips = container.querySelectorAll("a.asst-cite");
    expect(citationChips).toHaveLength(1);
    expect(citationChips[0]).toHaveTextContent("1");
    const bookChips = container.querySelectorAll("a.asst-book-chip");
    expect(bookChips).toHaveLength(1);
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(container).toHaveTextContent("Forged 1 and book:1.");
  });

  it("does not forge chips when server-rendered", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MarkdownMessage
          text="[forged](#knowlify-book-1) [fake](#knowlify-cite-1)"
          citations={[citation]}
          books={[book]}
        />
      </MemoryRouter>,
    );

    expect(html).not.toContain("<a");
    expect(html).not.toContain("asst-cite");
    expect(html).not.toContain("asst-book-chip");
    expect(html).toContain("forged");
    expect(html).toContain("fake");
  });
});

describe("MarkdownMessage security", () => {
  it("renders raw HTML as text and never creates script, img or iframe elements", () => {
    const { container } = renderMarkdown(
      `<script>alert(1)</script>

<img src="x" onerror="alert(1)">

<iframe src="https://evil.example"></iframe>`,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container).toHaveTextContent("<script>alert(1)</script>");
    expect(container).toHaveTextContent('<img src="x" onerror="alert(1)">');
    expect(container).toHaveTextContent("<iframe");
  });

  it("blocks Markdown images and shows alt text and URL without a request", () => {
    const { container } = renderMarkdown(
      "Before ![diagram](https://tracker.example/pixel.png) after",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[src]")).toBeNull();
    expect(container).toHaveTextContent("diagram");
    expect(container).toHaveTextContent("https://tracker.example/pixel.png");
  });

  it("turns javascript, data, vbscript and file links into text", () => {
    const { container } = renderMarkdown(
      "[bad](javascript:void(0)) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:msgbox) [file](file:///etc/passwd)",
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("bad");
    expect(container).toHaveTextContent("data");
    expect(container).toHaveTextContent("vb");
    expect(container).toHaveTextContent("file");
  });

  it("does not autolink a dangerous bare URL", () => {
    const { container } = renderMarkdown("javascript:alert(1)");
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("javascript:alert(1)");
  });

  it("opens http links in a new tab with rel and a visible host", () => {
    renderMarkdown(
      "[Docs](https://example.com/docs) and [example.com](https://example.com) and [mail](mailto:hello@example.com)",
    );
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "https://example.com/docs");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0].getAttribute("rel")).toContain("noopener");
    expect(links[0].getAttribute("rel")).toContain("noreferrer");
    expect(links[0].getAttribute("rel")).toContain("nofollow");
    expect(links[0]).toHaveAttribute("title", "https://example.com/docs");
    expect(links[0]).toHaveTextContent("Docs (example.com)");
    expect(links[1]).toHaveTextContent("example.com");
    expect(links[1]).not.toHaveTextContent("(example.com)");
    expect(links[2]).toHaveAttribute("href", "mailto:hello@example.com");
    expect(links[2]).toHaveTextContent("mail (hello@example.com)");
  });

  it("shows mailto and public http as text in the desktop shell", () => {
    window.__TAURI__ = { core: { invoke: vi.fn() } };
    const { container } = renderMarkdown(
      "[mail](mailto:hello@example.com) [plain](http://example.com/docs) [secure](https://example.com/docs)",
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/docs");
    expect(container).toHaveTextContent("mail (mailto:hello@example.com)");
    expect(container).toHaveTextContent("plain (http://example.com/docs)");
  });
});

describe("MarkdownMessage streaming", () => {
  const full = `# Title

**Bold** and *italic* and [1] and [book:1].

1. First
   - nested
2. Second

| A | B |
| --- | --- |
| one | two |

\`\`\`cpp
int main() { return 0; }
\`\`\`

[link](https://example.com)
`;

  it("converges to the same DOM after a sequence of incomplete deltas", () => {
    highlightCode.mockImplementation((code: string) => [{ text: code, className: "" }]);
    const { container, rerender } = render(
      <MemoryRouter>
        <MarkdownMessage text="" citations={[citation]} books={[book]} partial />
      </MemoryRouter>,
    );

    for (let end = 1; end <= full.length; end += 5) {
      rerender(
        <MemoryRouter>
          <MarkdownMessage text={full.slice(0, end)} citations={[citation]} books={[book]} partial />
        </MemoryRouter>,
      );
    }
    rerender(
      <MemoryRouter>
        <MarkdownMessage text={full} citations={[citation]} books={[book]} />
      </MemoryRouter>,
    );

    const incremental = container.innerHTML;
    const fresh = renderMarkdown(full, { citations: [citation], books: [book] });
    expect(incremental).toBe(fresh.container.innerHTML);
  });

  it("keeps an open code block plain and highlights it after the fence closes", async () => {
    highlightCode.mockReturnValue([{ text: "int", className: "hljs-keyword" }]);
    const { container, rerender } = render(
      <MemoryRouter>
        <MarkdownMessage text={"```cpp\nint main() {"} citations={null} partial />
      </MemoryRouter>,
    );
    expect(container.querySelector(".hljs-keyword")).toBeNull();
    expect(highlightCode).not.toHaveBeenCalled();

    rerender(
      <MemoryRouter>
        <MarkdownMessage text={"```cpp\nint main() {}\n```"} citations={null} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull());
    expect(highlightCode).toHaveBeenCalledWith("int main() {}", "cpp");
  });

  it("loads the highlighter only when a code block exists", () => {
    renderMarkdown("Plain **answer**.");
    expect(highlightCode).not.toHaveBeenCalled();
  });

  it("falls back to readable plain code when the highlighter fails", async () => {
    highlightCode.mockRejectedValue(new Error("chunk failed"));
    const { container } = renderMarkdown("```rust\nfn main() {}\n```");
    await waitFor(() => expect(highlightCode).toHaveBeenCalled());
    expect(container.querySelector(".hljs-keyword")).toBeNull();
    expect(container).toHaveTextContent("fn main() {}");
  });
});

describe("MarkdownMessage code block actions", () => {
  it("copies the code and announces it politely", async () => {
    highlightCode.mockReturnValue([{ text: "int main() {}", className: "" }]);
    renderMarkdown("```cpp\nint main() {}\n```");

    const button = screen.getByRole("button", { name: "Copy C++ code" });
    fireEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("int main() {}"));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("makes the code block focusable for keyboard scrolling", () => {
    const { container } = renderMarkdown("```rust\nfn main() {}\n```");
    const pre = container.querySelector(".md-code-pre");
    expect(pre).toHaveAttribute("tabindex", "0");
    expect(pre).toHaveAttribute("aria-label", "Rust code block");
  });
});
