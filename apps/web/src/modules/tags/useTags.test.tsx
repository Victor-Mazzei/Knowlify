import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tag } from "../../types";
import { tagErrorMessage } from "./tagsApi";
import { useTags } from "./useTags";

const tag = (id: string, name: string, extra: Partial<Tag> = {}) => ({
  id,
  name,
  color: "gray" as const,
  createdAt: 0,
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("useTags", () => {
  it("loads the cache with counts in name order", async () => {
    const api = vi.fn(async () => json({ items: [{ ...tag("b", "Zeta"), count: 2 }, { ...tag("a", "Alpha"), count: 0 }] }));
    const { result } = renderHook(() => useTags(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags.map((entry) => entry.name)).toEqual(["Alpha", "Zeta"]);
    expect(result.current.tags[1]?.count).toBe(2);
  });

  it("stays quiet when the server predates the tags contract", async () => {
    const api = vi.fn(async () => json({ message: "Not found" }, 404));
    const { result } = renderHook(() => useTags(api));
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.error).toBe("");
  });

  it("creates, renames, recolors and removes tags in the cache", async () => {
    let items = [{ ...tag("t1", "Old"), count: 3 }];
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/api/tags" && method === "GET") return json({ items });
      if (path === "/api/tags" && method === "POST") {
        const created = { ...tag("t2", "New", { color: "teal" }) };
        items = [...items, { ...created, count: 0 }];
        return json(created, 201);
      }
      if (path === "/api/tags/t1" && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Partial<Tag>;
        items = items.map((entry) => (entry.id === "t1" ? { ...entry, ...body } : entry));
        return json(items[0]);
      }
      if (path === "/api/tags/t1" && method === "DELETE") {
        items = items.filter((entry) => entry.id !== "t1");
        return new Response(null, { status: 204 });
      }
      return json({ message: "Not found" }, 404);
    });

    const { result } = renderHook(() => useTags(api));
    await waitFor(() => expect(result.current.tags).toHaveLength(1));

    await act(async () => {
      await result.current.create("New", "teal");
    });
    expect(result.current.tags.map((entry) => entry.name)).toEqual(["New", "Old"]);

    await act(async () => {
      await result.current.update("t1", { name: "Renamed", color: "red" });
    });
    expect(result.current.tags.find((entry) => entry.id === "t1")).toMatchObject({
      name: "Renamed",
      color: "red",
      count: 3,
    });

    await act(async () => {
      await result.current.remove("t1");
    });
    expect(result.current.tags.map((entry) => entry.id)).toEqual(["t2"]);
  });

  it("maps the server conflict codes to actionable messages", () => {
    expect(tagErrorMessage(Object.assign(new Error("conflict"), { code: "tag_name_taken" }))).toBe(
      "A tag with this name already exists.",
    );
    expect(tagErrorMessage(Object.assign(new Error("conflict"), { code: "book_tag_limit" }))).toBe(
      "A book cannot have more than 50 tags.",
    );
    expect(tagErrorMessage(new Error("offline"))).toBe("offline");
  });
});
