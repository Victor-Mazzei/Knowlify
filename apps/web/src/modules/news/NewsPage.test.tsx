import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsPage } from "./NewsPage";

const article = {
  id: "a1",
  feedId: "f1",
  feedTitle: "Climate",
  source: "Example News",
  title: "Climate story",
  link: "https://example.com/story",
  summary: "A plain text summary.",
  publishedAt: "2026-01-02T10:00:00.000Z",
};

function respond(url: string, init?: RequestInit, includeFeed = false) {
  if (url.endsWith("/api/scan")) {
    return new Response(JSON.stringify({ scanning: false, pending: 0, lastScanAt: null }));
  }
  if (url.endsWith("/api/sources")) return new Response(JSON.stringify([]));
  if (url.endsWith("/api/news/feeds") && init?.method === "POST") return new Response(JSON.stringify({}), { status: 201 });
  if (url.endsWith("/api/news/feeds")) {
    const feeds = includeFeed
      ? [{ id: "f1", kind: "topic", title: "Climate", url: "https://news.example/climate", query: "climate", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" }]
      : [];
    return new Response(JSON.stringify(feeds));
  }
  if (url.endsWith("/api/news/bookmarks")) return new Response(JSON.stringify([]));
  if (url.includes("/api/news/search")) return new Response(JSON.stringify({ articles: [article], errors: [] }));
  if (url.includes("/api/news/articles")) return new Response(JSON.stringify({ articles: [], errors: [] }));
  return new Response("{}", { status: 404 });
}

function renderPage(initialEntries = ["/news"], includeFeed = false) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init, includeFeed));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <NewsPage credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} />
    </MemoryRouter>,
  );
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("NewsPage", () => {
  it("searches and renders results", async () => {
    const fetchMock = renderPage();
    fireEvent.change(screen.getByRole("textbox", { name: "Search news" }), { target: { value: "climate" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Climate story")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/news/search?q=climate"))).toBe(true));
  });

  it("searches from the q query parameter on mount", async () => {
    const fetchMock = renderPage(["/news?q=climate"]);
    await screen.findByText("Climate story");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/news/search?q=climate"))).toBe(true);
  });

  it("follows a topic", async () => {
    const fetchMock = renderPage(["/news?q=climate"]);
    await screen.findByText("Climate story");
    fireEvent.click(screen.getByRole("button", { name: "Follow topic" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/news/feeds") && init?.method === "POST");
      expect(call?.[1]?.body).toBe(JSON.stringify({ kind: "topic", query: "climate" }));
    });
  });

  it("loads only the selected feed after leaving a search", async () => {
    const fetchMock = renderPage(["/news?q=climate"], true);
    await screen.findByText("Climate story");
    fireEvent.click(screen.getByRole("button", { name: "Climate" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/news/articles?feedId=f1"))).toBe(true);
    });
    const articleCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/api/news/articles"));
    expect(articleCalls.some((url) => url.includes("?limit=50"))).toBe(false);
  });

  it("uses safe attributes for article links", async () => {
    renderPage(["/news?q=climate"]);
    const link = await screen.findByRole("link", { name: "Climate story" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
