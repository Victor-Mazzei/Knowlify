import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../../types";
import { BookCard } from "./BookCard";
import { COVER_CONCURRENCY, resetCoverQueue } from "./useCoverQueue";

const book = (index: number): Book => ({
  id: `cover-${index}`,
  title: `Cover ${index}`,
  author: "",
  format: "epub",
  size: 1,
  addedAt: 0,
  hasCover: true,
  status: "ready",
  source: true,
});

// jsdom's Blob has no stream(), which the platform Response requires for Blob
// bodies, so fake cover payloads with bytes instead.
const coverResponse = () =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "Content-Type": "image/png" } });

beforeEach(() => {
  resetCoverQueue();
  URL.createObjectURL = vi.fn(() => `blob:cover-${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  resetCoverQueue();
  vi.restoreAllMocks();
});

describe("useCoverQueue", () => {
  it("keeps at most six cover requests in flight for a hundred cards", async () => {
    let inFlight = 0;
    let peak = 0;
    const waiting: { path: string; resolve: (respond: boolean) => void }[] = [];
    const signals: AbortSignal[] = [];
    const api = vi.fn((path: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<Response>((resolve, reject) => {
        let settled = false;
        const finish = (respond: boolean) => {
          if (settled) return;
          settled = true;
          inFlight -= 1;
          if (respond) resolve(coverResponse());
          else reject(new DOMException("Aborted", "AbortError"));
        };
        init?.signal?.addEventListener("abort", () => finish(false));
        waiting.push({ path, resolve: finish });
      });
    });

    const { unmount } = render(
      <MemoryRouter>
        {Array.from({ length: 100 }, (_, index) => (
          <BookCard key={index} book={book(index)} api={api} onDelete={vi.fn()} />
        ))}
      </MemoryRouter>,
    );
    await waitFor(() => expect(api).toHaveBeenCalledTimes(COVER_CONCURRENCY));
    expect(peak).toBeLessThanOrEqual(COVER_CONCURRENCY);
    expect(api).toHaveBeenCalledWith(expect.stringContaining("?size=thumb"), expect.anything());

    await act(async () => {
      waiting.splice(0, COVER_CONCURRENCY).forEach((request) => request.resolve(true));
    });
    await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(COVER_CONCURRENCY));
    expect(peak).toBeLessThanOrEqual(COVER_CONCURRENCY);

    unmount();
    expect(signals.some((signal) => signal.aborted)).toBe(true);
    resetCoverQueue();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("falls back to the current cover endpoint when thumbnails are unavailable", async () => {
    const api = vi.fn(async (path: string) =>
      path.includes("?size=thumb")
        ? new Response(JSON.stringify({ message: "No thumbnail" }), { status: 404 })
        : coverResponse(),
    );
    render(
      <MemoryRouter>
        <BookCard book={book(1)} api={api} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("img", { name: "Cover of Cover 1" })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(expect.stringContaining("?size=thumb"), expect.anything());
    expect(api).toHaveBeenCalledWith("/api/books/cover-1/cover", expect.anything());
  });
});
