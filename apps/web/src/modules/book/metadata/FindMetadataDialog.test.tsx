import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../../components/dialogs";
import type { BookDetail } from "../types";
import { sampleBookDetail } from "./mockMetadataBook";
import { createMockMetadataApi, type MockMetadataOptions } from "./mockMetadataApi";
import { FindMetadataDialog } from "./FindMetadataDialog";

type Call = { path: string; init?: RequestInit };

const spyApi = (inner: ApiFn) => {
  const calls: Call[] = [];
  const api: ApiFn = (path, init) => {
    calls.push({ path, init });
    return inner(path, init);
  };
  return { api, calls };
};

const withIsbn = (isbn13: string | null = "9780306406157"): BookDetail =>
  sampleBookDetail({}, { isbn13, isbn10: isbn13 ? "0306406152" : null });

const renderDialog = (book: BookDetail, api: ApiFn) => {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <MemoryRouter>
      <FindMetadataDialog book={book} api={api} onClose={onClose} onSaved={onSaved} />
    </MemoryRouter>,
  );
  return { onSaved, onClose, ...view };
};

const renderFind = (book: BookDetail, options: MockMetadataOptions = {}) => {
  const mock = spyApi(createMockMetadataApi(options));
  return { ...mock, ...renderDialog(book, mock.api) };
};

const bodyOf = (call: Call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>;

const searchForFirstCandidate = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Search online" }));
  const list = await screen.findByRole("list", { name: "Metadata matches" });
  fireEvent.click(within(list).getAllByRole("button")[0]!);
  return list;
};

describe("FindMetadataDialog", () => {
  it("explains the privacy exchange and never searches until asked", async () => {
    const { calls } = renderFind(withIsbn());
    expect(await screen.findByLabelText("ISBN")).toHaveValue("9780306406157");
    expect(screen.getByText(/sent to Open Library and, only if it finds nothing or fails, to Google Books/)).toBeInTheDocument();
    expect(calls.filter((call) => call.path.startsWith("/api/metadata/search"))).toHaveLength(0);
    expect(calls.some((call) => call.path === "/api/metadata/status")).toBe(true);
  });

  it("searches by ISBN and applies the chosen fields with the provider as source", async () => {
    const { calls, onSaved, container } = renderFind(withIsbn());
    await screen.findByLabelText("ISBN");
    const list = await searchForFirstCandidate();
    expect(within(list).getByText("The Quiet Library")).toBeInTheDocument();
    expect(screen.getByText("Apply from Google Books")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Apply \d+ changes$/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const patch = calls.find((call) => call.path.endsWith("/metadata") && call.init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(bodyOf(patch!)).toMatchObject({
      title: "The Quiet Library",
      author: "Ada North",
      isbn13: "9780306406157",
      year: 2005,
      publisher: "North Press",
      source: "googlebooks",
    });
    expect(await screen.findByText("Metadata applied.")).toBeInTheDocument();
  });

  it("copies only the checked fields and downloads the cover only when opted in", async () => {
    const { calls, onSaved } = renderFind(withIsbn());
    await screen.findByLabelText("ISBN");
    await searchForFirstCandidate();

    fireEvent.click(screen.getByRole("checkbox", { name: "Apply Description" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply cover" }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply \d+ changes$/ }));

    expect(await screen.findByText("Metadata and cover applied.")).toBeInTheDocument();
    const patch = calls.find((call) => call.path.endsWith("/metadata") && call.init?.method === "PATCH");
    expect(bodyOf(patch!)).not.toHaveProperty("description");
    const cover = calls.find((call) => call.path.endsWith("/cover/from-url"));
    expect(cover).toBeDefined();
    expect(bodyOf(cover!)).toEqual({ url: "https://books.google.com/books/content?id=quiet&printsec=frontcover" });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("searches by title and author when the book has no ISBN", async () => {
    const { calls } = renderFind(withIsbn(null));
    const title = await screen.findByLabelText("Title");
    expect(title).toHaveValue("The Quiet Library");
    fireEvent.change(title, { target: { value: "Silent Shelf" } });
    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "Mira Costa" } });
    fireEvent.click(screen.getByRole("button", { name: "Search online" }));

    await screen.findByRole("list", { name: "Metadata matches" });
    expect(calls.some((call) => call.path.includes("title=Silent+Shelf&author=Mira+Costa"))).toBe(true);
  });

  it("reports partial provider failures and an empty result", async () => {
    renderFind(withIsbn(), {
      candidates: [],
      searchErrors: [{ source: "openlibrary", code: "timeout" }],
    });
    await screen.findByLabelText("ISBN");
    fireEvent.click(screen.getByRole("button", { name: "Search online" }));
    expect(await screen.findByText("No matches from the providers.")).toBeInTheDocument();
    expect(screen.getByText(/Open Library took too long to answer/)).toBeInTheDocument();
    expect(screen.getByText(/Check the ISBN or try a shorter title/)).toBeInTheDocument();
  });

  it("shows another provider's candidates beside a provider problem", async () => {
    renderFind(withIsbn(), { scenario: "rate-limited" });
    await screen.findByLabelText("ISBN");
    fireEvent.click(screen.getByRole("button", { name: "Title and author" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Quiet Library" } });
    fireEvent.click(screen.getByRole("button", { name: "Search online" }));

    const list = await screen.findByRole("list", { name: "Metadata matches" });
    expect(within(list).getByText("The Quiet Library: A Reader's History")).toBeInTheDocument();
    expect(await screen.findByText(/Google Books is limiting requests/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings/metadata");
  });

  it("explains the most actionable failure first when nothing matched", async () => {
    renderFind(withIsbn(), {
      candidates: [],
      searchErrors: [
        { source: "openlibrary", code: "timeout", reason: "timeout" },
        { source: "googlebooks", code: "unavailable", reason: "service_disabled" },
      ],
    });
    await screen.findByLabelText("ISBN");
    fireEvent.click(screen.getByRole("button", { name: "Search online" }));

    expect(await screen.findByText(/Google Books refused the request/)).toBeInTheDocument();
    expect(screen.queryByText(/Open Library took too long/)).not.toBeInTheDocument();
    expect(screen.getByText(/KNOWLIFY_LOG_LEVEL=debug/)).toBeInTheDocument();
  });

  it("falls back to the generic code text for an unknown reason", async () => {
    const inner = createMockMetadataApi();
    const api: ApiFn = (path, init) =>
      path.startsWith("/api/metadata/search")
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                candidates: [],
                errors: [{ source: "googlebooks", code: "unavailable", reason: "future_reason" }],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          )
        : inner(path, init);
    renderDialog(withIsbn(), api);
    await screen.findByLabelText("ISBN");
    fireEvent.click(screen.getByRole("button", { name: "Search online" }));

    expect(await screen.findByText("Google Books could not be reached.")).toBeInTheDocument();
  });

  it("links key problems to the metadata settings route", async () => {
    renderFind(withIsbn(), { scenario: "key-rejected" });
    await screen.findByLabelText("ISBN");
    fireEvent.click(screen.getByRole("button", { name: "Search online" }));

    expect(await screen.findByText(/Google Books rejected the API key/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings > Metadata lookup" })).toHaveAttribute(
      "href",
      "/settings/metadata",
    );
  });

  it("keeps the debug hint out of a plain empty result", async () => {
    renderFind(withIsbn(), { scenario: "empty" });
    await screen.findByLabelText("ISBN");
    fireEvent.click(screen.getByRole("button", { name: "Search online" }));

    expect(await screen.findByText("No matches from the providers.")).toBeInTheDocument();
    expect(screen.queryByText(/KNOWLIFY_LOG_LEVEL=debug/)).not.toBeInTheDocument();
  });

  it("explains a rate-limited search", async () => {
    renderFind(withIsbn(), { rateLimitAfter: 0 });
    await screen.findByLabelText("ISBN");
    fireEvent.click(screen.getByRole("button", { name: "Search online" }));
    expect(await screen.findByText(/Too many searches right now/)).toBeInTheDocument();
  });

  it("hides the search form when lookup is off or unsupported", async () => {
    const off = renderFind(withIsbn(), { lookup: "off" });
    expect(await screen.findByText(/turned off on this server/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search online" })).not.toBeInTheDocument();
    off.unmount();

    renderFind(withIsbn(), { lookup: "unsupported" });
    expect(await screen.findByText(/does not support online metadata lookup/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search online" })).not.toBeInTheDocument();
  });
});
