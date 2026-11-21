import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Reader } from "./Reader";

afterEach(() => vi.unstubAllGlobals());

describe("Reader", () => {
  it("loads one book by id instead of downloading the whole library", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/books/missing")) return new Response(JSON.stringify({ message: "Book not found." }), { status: 404 });
      return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/read/missing"]}>
        <Routes>
          <Route path="/read/:id" element={<Reader credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Book not found.");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/books"))).toBe(false);
  });
});
