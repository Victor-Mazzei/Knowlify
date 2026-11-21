import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { useConversations } from "./useConversations";
import type { ConversationSummary } from "./types";

const summary = (id: string, bookId?: string): ConversationSummary => ({
  id,
  title: id,
  scope: bookId ? { kind: "book", bookId } : { kind: "library" },
  updatedAt: 1,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("useConversations", () => {
  it("drops a late response from the previous scope", async () => {
    const first = deferred<Response>();
    const api: ApiFn = async (path) => {
      const url = new URL(path, "http://mock.local");
      if (url.searchParams.get("bookId") === "a") return first.promise;
      return json([summary("b1", "b")]);
    };
    const { result, rerender } = renderHook(
      ({ bookId }: { bookId: string }) =>
        useConversations({ api, bookId, enabled: true, revision: 0 }),
      { initialProps: { bookId: "a" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ bookId: "b" });
    await waitFor(() => expect(result.current.conversations.map((item) => item.id)).toEqual(["b1"]));

    await act(async () => first.resolve(json([summary("a1", "a")])));
    expect(result.current.conversations.map((item) => item.id)).toEqual(["b1"]);
  });

  it("removes a row immediately and restores it when the server rejects the delete", async () => {
    const api: ApiFn = async (_path, init) => {
      if (init?.method === "DELETE") throw new Error("The server could not delete it.");
      return json([summary("mock-1")]);
    };
    const { result } = renderHook(() =>
      useConversations({ api, enabled: true, revision: 0 }),
    );
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));

    await act(async () => {
      await expect(result.current.remove("mock-1")).rejects.toThrow("The server could not delete it.");
    });

    expect(result.current.conversations.map((item) => item.id)).toEqual(["mock-1"]);
    expect(result.current.deletingIds.size).toBe(0);
  });

  it("does not resurrect a deleted row when a list response arrives late", async () => {
    const late = deferred<Response>();
    let lists = 0;
    const api: ApiFn = async (_path, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      lists += 1;
      if (lists === 1) return json([summary("mock-1"), summary("mock-2")]);
      return late.promise;
    };
    const { result } = renderHook(() =>
      useConversations({ api, enabled: true, revision: 0 }),
    );
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));

    const pending = act(async () => result.current.refresh());
    await act(async () => {
      await result.current.remove("mock-1");
    });
    await act(async () => {
      late.resolve(json([summary("mock-1"), summary("mock-2")]));
      await pending;
    });

    expect(result.current.conversations.map((item) => item.id)).toEqual(["mock-2"]);
  });
});
