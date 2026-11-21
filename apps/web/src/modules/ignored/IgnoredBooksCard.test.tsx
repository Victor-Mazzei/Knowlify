import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { IgnoredBook } from "../../types";
import { IgnoredBooksCard } from "./IgnoredBooksCard";

const entry = (id: string, overrides: Partial<IgnoredBook> = {}): IgnoredBook => ({
  id,
  title: `Book ${id}`,
  author: "An Author",
  format: "epub",
  size: 2_097_152,
  path: `/library/${id}.epub`,
  sourceId: "source-1",
  reason: "path",
  managed: false,
  ignoredAt: Date.UTC(2026, 10, 7),
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(overrides: Record<string, unknown> = {}) {
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/ignored-books?") && (init?.method ?? "GET") === "GET") {
      return json({ items: [entry("a")], total: 2, ...overrides });
    }
    if (path === "/api/ignored-books/restore") return json({ restored: 1, scanStarted: true });
    return json({ message: "Not found" }, 404);
  });
  render(
    <MemoryRouter>
      <IgnoredBooksCard api={api} />
    </MemoryRouter>,
  );
  return api;
}

describe("IgnoredBooksCard", () => {
  it("lists ignored books with the reason and path", async () => {
    setup();
    expect(await screen.findByText("Book a")).toBeInTheDocument();
    expect(screen.getByText("2 books ignored")).toBeInTheDocument();
    expect(screen.getByText(/Removed by path/)).toBeInTheDocument();
    expect(screen.getByTitle("/library/a.epub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore Book a" })).toBeInTheDocument();
  });

  it("restores a book and explains that notes and progress are gone", async () => {
    const api = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Restore Book a" }));
    expect(await screen.findByText(/comes back as a new book; notes and progress are not recovered/)).toBeInTheDocument();
    expect(screen.queryByText("Book a")).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/ignored-books/restore", expect.objectContaining({ method: "POST" }));
  });

  it("loads the next page with an offset", async () => {
    const api = setup({ items: [entry("a")], total: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(api.mock.calls.some(([path]) => String(path).includes("offset=1"))).toBe(true),
    );
  });

  it("hides itself on a server without the ignored-books contract", async () => {
    const api = vi.fn(async () => json({ message: "Not found" }, 404));
    const { container } = render(
      <MemoryRouter>
        <IgnoredBooksCard api={api} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(container.querySelector("#ignored-books")).toBeNull();
  });
});
