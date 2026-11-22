import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { useChat } from "./useChat";

const encoder = new TextEncoder();

type StreamOptions = {
  signal?: AbortSignal | null;
  onCancel?: () => void;
  failAfter?: Error;
  close?: boolean;
};

const sseResponse = (events: unknown[], options: StreamOptions = {}) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (options.failAfter) {
          setTimeout(() => {
            try {
              controller.error(options.failAfter);
            } catch {
              /* already closed */
            }
          }, 0);
        } else if (options.close !== false) {
          controller.close();
        }
        options.signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            /* already closed */
          }
        });
      },
      cancel() {
        options.onCancel?.();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const eventResponse = (events: unknown[]) => sseResponse(events);

const hangingResponse = (events: unknown[], signal: AbortSignal | null | undefined, onCancel?: () => void) =>
  sseResponse(events, { signal, onCancel, close: false });

const successEvents = [
  { type: "sources", conversationId: "c1", retrieval: "hybrid", citations: [{ n: 1, passageId: 4, bookId: "b1", bookTitle: "Book", page: 12, section: null }] },
  { type: "delta", text: "Start " },
  { type: "delta", text: "here [1]." },
  { type: "done", conversationId: "c1", messageId: "m2", title: "How?", finishReason: "stop" },
];

const followUpEvents = [
  { type: "sources", conversationId: "c1", retrieval: "none", citations: [] },
  { type: "delta", text: "Second answer." },
  { type: "done", conversationId: "c1", messageId: "m4", title: "How?", finishReason: "stop" },
];

const retriedEvents = [
  { type: "sources", conversationId: "c2", retrieval: "none", citations: [] },
  { type: "delta", text: "A new answer." },
  { type: "done", conversationId: "c2", messageId: "m3", title: "Question", finishReason: "stop" },
];

const conversationDetail = {
  id: "c9",
  title: "Saved",
  scope: { kind: "library" },
  messages: [
    { id: "m1", role: "user", content: "Old question", citations: null, createdAt: 1 },
    { id: "m2", role: "assistant", content: "Old answer", citations: null, createdAt: 2 },
  ],
};

describe("useChat", () => {
  it("streams a turn, keeps citations and reports the conversation with the server message id", async () => {
    const requests: RequestInit[] = [];
    const api: ApiFn = async (_path, init) => {
      requests.push(init ?? {});
      return eventResponse(successEvents);
    };
    const onConversation = vi.fn();
    const { result } = renderHook(() => useChat({ api, scope: { kind: "library" }, onConversation }));

    act(() => result.current.send("How?"));
    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:How?",
      "assistant:Start here [1].",
    ]);
    // The draft id is replaced by `done.messageId`; a later send must not clean it as a draft.
    expect(result.current.messages[1]?.id).toBe("m2");
    expect(result.current.messages[1]?.incomplete).toBe(false);
    expect(result.current.messages[1]?.citations?.[0]?.n).toBe(1);
    expect(result.current.conversationId).toBe("c1");
    expect(onConversation).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", title: "How?", scope: { kind: "library" } }));

    const body = JSON.parse(String(requests[0]?.body)) as { message: string; scope: { kind: string } };
    expect(body.message).toBe("How?");
    expect(body.scope).toEqual({ kind: "library" });
  });

  it("sends the reader excerpt only in book scope", async () => {
    const requests: RequestInit[] = [];
    const api: ApiFn = async (_path, init) => {
      requests.push(init ?? {});
      return eventResponse(successEvents);
    };
    const { result } = renderHook(() =>
      useChat({ api, scope: { kind: "book", bookId: "b1" } }),
    );

    act(() =>
      result.current.send("Explain this", {
        text: "  A short passage.\nWith two lines.  ",
        kind: "selection",
        page: 7,
        section: "Chapter 2",
      }),
    );
    await waitFor(() => expect(result.current.streaming).toBe(false));

    const body = JSON.parse(String(requests[0]?.body)) as {
      scope: { kind: string; excerpt?: string; excerptKind?: string; page?: number; section?: string };
    };
    expect(body.scope).toEqual({
      kind: "book",
      bookId: "b1",
      excerpt: "A short passage. With two lines.",
      excerptKind: "selection",
      page: 7,
      section: "Chapter 2",
    });
  });

  it("keeps the first answer when a second question is sent in the same mount", async () => {
    const requests: Array<{ conversationId?: string }> = [];
    const api: ApiFn = async (_path, init) => {
      requests.push(JSON.parse(String(init?.body)) as { conversationId?: string });
      return requests.length === 1 ? eventResponse(successEvents) : eventResponse(followUpEvents);
    };
    const { result } = renderHook(() => useChat({ api, scope: { kind: "library" } }));

    act(() => result.current.send("How?"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    act(() => result.current.send("Again?"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    await waitFor(() => expect(result.current.messages).toHaveLength(4));

    expect(result.current.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:How?",
      "assistant:Start here [1].",
      "user:Again?",
      "assistant:Second answer.",
    ]);
    expect(result.current.messages[1]?.id).toBe("m2");
    expect(result.current.messages[3]?.id).toBe("m4");
    expect(requests).toEqual([{ message: "How?", scope: { kind: "library" } }, { message: "Again?", scope: { kind: "library" }, conversationId: "c1" }]);
  });

  it("keeps the partial answer on an SSE error and Retry replaces only that draft", async () => {
    const requests: Array<{ conversationId?: string }> = [];
    let calls = 0;
    const api: ApiFn = async (_path, init) => {
      calls += 1;
      requests.push(JSON.parse(String(init?.body)) as { conversationId?: string });
      if (calls === 1)
        return eventResponse([
          { type: "sources", conversationId: "c1", retrieval: "hybrid", citations: [] },
          { type: "delta", text: "Let me" },
          { type: "error", code: "llm_timeout", message: "The model took too long." },
        ]);
      return eventResponse(retriedEvents);
    };
    const { result } = renderHook(() => useChat({ api, scope: { kind: "library" } }));

    act(() => result.current.send("Question"));
    await waitFor(() => expect(result.current.error).toBe("The model took too long."));
    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Question",
      "assistant:Let me",
    ]);
    expect(result.current.messages[1]?.incomplete).toBe(true);
    expect(result.current.conversationId).toBeUndefined();
    expect(result.current.canRetry).toBe(true);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.streaming).toBe(false));
    await waitFor(() => expect(result.current.messages[result.current.messages.length - 1]?.content).toBe("A new answer."));

    expect(result.current.error).toBe("");
    expect(result.current.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(result.current.messages.some((message) => message.content === "Let me")).toBe(false);
    expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(1);
    // `sources` carries a provisional conversation id; Retry must not adopt it.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.conversationId).toBeUndefined();
    expect(requests[1]?.conversationId).toBeUndefined();
    expect(result.current.conversationId).toBe("c2");
    expect(result.current.canRetry).toBe(false);
  });

  it("keeps the partial answer when the connection closes before done", async () => {
    const api: ApiFn = async () =>
      eventResponse([
        { type: "sources", conversationId: "c1", retrieval: "none", citations: [] },
        { type: "delta", text: "Half" },
      ]);
    const { result } = renderHook(() => useChat({ api, scope: { kind: "library" } }));

    act(() => result.current.send("Question"));
    await waitFor(() => expect(result.current.error).toBe("The connection closed before the answer finished. Try again."));
    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Question",
      "assistant:Half",
    ]);
    expect(result.current.messages[1]?.incomplete).toBe(true);
    expect(result.current.canRetry).toBe(true);
  });

  it("keeps the partial answer on a transport error", async () => {
    const api: ApiFn = async () =>
      sseResponse([{ type: "delta", text: "Partial" }], { failAfter: new Error("Network lost") });
    const { result } = renderHook(() => useChat({ api, scope: { kind: "library" } }));

    act(() => result.current.send("Question"));
    await waitFor(() => expect(result.current.error).toBe("Network lost"));
    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages[1]?.content).toBe("Partial");
    expect(result.current.messages[1]?.incomplete).toBe(true);
    expect(result.current.canRetry).toBe(true);
  });

  it("removes an empty failed draft instead of leaving a blank answer", async () => {
    const api: ApiFn = async () =>
      eventResponse([
        { type: "sources", conversationId: "c1", retrieval: "none", citations: [] },
        { type: "error", code: "llm_empty", message: "The language model returned no answer" },
      ]);
    const { result } = renderHook(() => useChat({ api, scope: { kind: "library" } }));

    act(() => result.current.send("Question"));
    await waitFor(() => expect(result.current.error).toBe("The language model returned no answer"));
    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages.map((message) => message.role)).toEqual(["user"]);
    expect(result.current.canRetry).toBe(true);
  });

  it("stops the stream, marks the partial answer incomplete and cancels the reader", async () => {
    const requests: Array<{ conversationId?: string }> = [];
    let signal: AbortSignal | null | undefined;
    let cancelled = false;
    let calls = 0;
    const api: ApiFn = async (_path, init) => {
      calls += 1;
      signal = init?.signal;
      requests.push(JSON.parse(String(init?.body)) as { conversationId?: string });
      if (calls === 1)
        return hangingResponse(
          [
            { type: "sources", conversationId: "c1", retrieval: "none", citations: [] },
            { type: "delta", text: "Partial" },
          ],
          signal,
          () => {
            cancelled = true;
          },
        );
      return eventResponse(retriedEvents);
    };
    const { result } = renderHook(() => useChat({ api, scope: { kind: "library" } }));

    act(() => result.current.send("Question"));
    await waitFor(() => expect(result.current.messages[result.current.messages.length - 1]?.content).toBe("Partial"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(result.current.stopped).toBe(true);
    expect(result.current.conversationId).toBeUndefined();
    expect(result.current.canRetry).toBe(true);
    expect(result.current.messages[result.current.messages.length - 1]?.incomplete).toBe(true);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.streaming).toBe(false));
    await waitFor(() => expect(result.current.messages[result.current.messages.length - 1]?.content).toBe("A new answer."));

    expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(result.current.messages.some((message) => message.content === "Partial")).toBe(false);
    expect(result.current.stopped).toBe(false);
    expect(result.current.canRetry).toBe(false);
    // `sources` carries a provisional conversation id; Retry must not adopt it.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.conversationId).toBeUndefined();
    expect(requests[1]?.conversationId).toBeUndefined();
    expect(result.current.conversationId).toBe("c2");
  });

  it("aborts and cancels the live stream when the panel unmounts", async () => {
    let signal: AbortSignal | null | undefined;
    let cancelled = false;
    const api: ApiFn = async (_path, init) => {
      signal = init?.signal;
      return hangingResponse([{ type: "delta", text: "Partial" }], signal, () => {
        cancelled = true;
      });
    };
    const { result, unmount } = renderHook(() => useChat({ api, scope: { kind: "library" } }));

    act(() => result.current.send("Question"));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("keeps an existing conversation id when a turn fails and is retried", async () => {
    const requests: Array<{ conversationId?: string }> = [];
    const api: ApiFn = async (_path, init) => {
      if (init?.method !== "POST") return new Response(JSON.stringify(conversationDetail));
      requests.push(JSON.parse(String(init.body)) as { conversationId?: string });
      if (requests.length === 1)
        return eventResponse([
          { type: "sources", conversationId: "c9", retrieval: "none", citations: [] },
          { type: "delta", text: "Half" },
          { type: "error", code: "llm_timeout", message: "The model took too long." },
        ]);
      return eventResponse([
        { type: "sources", conversationId: "c9", retrieval: "none", citations: [] },
        { type: "delta", text: "Continued answer." },
        { type: "done", conversationId: "c9", messageId: "m4", title: "Follow-up", finishReason: "stop" },
      ]);
    };
    const { result } = renderHook(() =>
      useChat({ api, scope: { kind: "library" }, initialConversationId: "c9" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.send("Follow-up"));
    await waitFor(() => expect(result.current.error).toBe("The model took too long."));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.conversationId).toBe("c9");
    expect(result.current.messages[result.current.messages.length - 1]?.incomplete).toBe(true);

    act(() => result.current.retry());
    await waitFor(() =>
      expect(result.current.messages[result.current.messages.length - 1]?.content).toBe("Continued answer."),
    );

    expect(requests.map((body) => body.conversationId)).toEqual(["c9", "c9"]);
    expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(result.current.messages.some((message) => message.content === "Half")).toBe(false);
    expect(result.current.conversationId).toBe("c9");
  });

  it("does not reload the conversation when a stable api is re-rendered", async () => {
    const api = vi.fn(async () => new Response(JSON.stringify(conversationDetail)));
    const { result, rerender } = renderHook(() =>
      useChat({ api, scope: { kind: "library" }, initialConversationId: "c9" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("loads an existing conversation", async () => {
    const api: ApiFn = async () => new Response(JSON.stringify(conversationDetail));
    const { result } = renderHook(() => useChat({ api, scope: { kind: "library" }, initialConversationId: "c9" }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((message) => message.content)).toEqual(["Old question", "Old answer"]);
    expect(result.current.conversationId).toBe("c9");
  });
});
