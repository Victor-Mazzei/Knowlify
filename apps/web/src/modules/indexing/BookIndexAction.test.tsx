import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "../../types";
import { BookIndexAction } from "./BookIndexAction";
import { indexStatus } from "./fixtures";
import { IndexStatusContext } from "./IndexStatusContext";

const book = (overrides: Partial<Book> = {}): Book => ({
  id: "b1",
  title: "A Book",
  author: "An Author",
  format: "epub",
  size: 1024,
  addedAt: 0,
  hasCover: false,
  status: "ready",
  source: false,
  index: { state: "none", error: null },
  ...overrides,
});

function renderAction(value: Book, api = vi.fn(async () => new Response(JSON.stringify({ queued: 1, skipped: 0 }), { status: 202 })), enabled = true) {
  const status = indexStatus({ enabled });
  const refresh = vi.fn(async () => status);
  const view = render(
    <IndexStatusContext.Provider value={{ status, available: true, refresh }}>
      <BookIndexAction book={value} api={api} />
    </IndexStatusContext.Provider>,
  );
  return { api, refresh, view };
}

describe("BookIndexAction", () => {
  it("stays hidden outside the shell, on old servers and when indexing is off", () => {
    const outside = render(<BookIndexAction book={book()} api={vi.fn()} />);
    expect(outside.container).toBeEmptyDOMElement();

    const oldServer = renderAction(book({ index: undefined }));
    expect(oldServer.view.container).toBeEmptyDOMElement();

    const disabled = renderAction(book(), undefined, false);
    expect(disabled.view.container).toBeEmptyDOMElement();
  });

  it("stays hidden while the book is already queued or still importing", () => {
    for (const value of [
      book({ index: { state: "pending", error: null } }),
      book({ index: { state: "indexing", error: null } }),
      book({ status: "pending" }),
    ]) {
      const { view } = renderAction(value);
      expect(view.container).toBeEmptyDOMElement();
    }
  });

  it("queues the book with vectors and confirms the result", async () => {
    const { api, refresh } = renderAction(book());
    fireEvent.click(screen.getByRole("button", { name: "Index A Book for search" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/index/enqueue",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ bookIds: ["b1"], vectors: true }),
        }),
      ),
    );
    expect(await screen.findByText("Queued for search.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Index A Book for search" })).toBeEnabled();
  });

  it("offers a retry after a failed request", async () => {
    const api = vi.fn(async () => {
      throw new Error("Indexing is disabled");
    });
    const { refresh } = renderAction(book({ index: { state: "error", error: null } }), api);
    fireEvent.click(screen.getByRole("button", { name: "Index A Book for search" }));

    expect(await screen.findByRole("button", { name: "Retry A Book for search" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Indexing is disabled");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses reindex wording for a book that already has an index", () => {
    renderAction(book({ index: { state: "ready", error: null } }));
    expect(screen.getByRole("button", { name: "Reindex A Book for search" })).toBeInTheDocument();
  });
});
