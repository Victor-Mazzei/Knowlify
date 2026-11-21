import { describe, expect, it, vi } from "vitest";
import { setBookFavorite, setBookFavorites } from "./favoritesApi";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("favoritesApi", () => {
  it("uses PUT to favorite and DELETE to unfavorite one book", async () => {
    const api = vi.fn(async () => json({ favorite: true }));
    await expect(setBookFavorite(api, "book/1", true)).resolves.toBe(true);
    expect(api).toHaveBeenCalledWith("/api/books/book%2F1/favorite", { method: "PUT" });

    api.mockResolvedValueOnce(json({ favorite: false }));
    await expect(setBookFavorite(api, "book-2", false)).resolves.toBe(false);
    expect(api).toHaveBeenLastCalledWith("/api/books/book-2/favorite", { method: "DELETE" });
  });

  it("rejects an unexpected single-book payload", async () => {
    const api = vi.fn(async () => json({ favorite: "yes" }));
    await expect(setBookFavorite(api, "book-1", true)).rejects.toThrow(
      "unexpected favorite state",
    );
  });

  it("keeps the API error on a missing book", async () => {
    const api = vi.fn(async () => json({ message: "Not found" }, 404));
    await expect(setBookFavorite(api, "book-1", true)).rejects.toMatchObject({
      status: 404,
      message: "Not found",
    });
  });

  it("sends the top-level selection and returns the updated count", async () => {
    const api = vi.fn(async () => json({ updated: 3 }));
    const selection = { ids: ["a", "b"] };
    await expect(setBookFavorites(api, selection, true)).resolves.toBe(3);
    expect(api).toHaveBeenCalledWith("/api/books/favorite", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["a", "b"], favorite: true }),
    });

    const filtered = { filter: { favorite: "1" }, expectedTotal: 4 };
    api.mockResolvedValueOnce(json({ updated: 4 }));
    await expect(setBookFavorites(api, filtered, false)).resolves.toBe(4);
    expect(api).toHaveBeenLastCalledWith("/api/books/favorite", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { favorite: "1" }, expectedTotal: 4, favorite: false }),
    });
  });

  it("rejects an unexpected bulk payload", async () => {
    const api = vi.fn(async () => json({ updated: "three" }));
    await expect(setBookFavorites(api, { ids: ["a"] }, false)).rejects.toThrow(
      "unexpected favorite update",
    );
  });
});
