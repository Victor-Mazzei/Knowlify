import { describe, expect, it, vi } from "vitest";
import { createSseParser, parseChatEvent } from "./sse";

const collect = () => {
  const received: Array<{ event: string; data: string }> = [];
  const parser = createSseParser((message) => received.push(message));
  return { received, parser };
};

describe("createSseParser", () => {
  it("reassembles events split across chunks", () => {
    const { received, parser } = collect();
    parser.feed('data: {"type":"delta","text":"Hel');
    parser.feed('lo"}\n\n');
    parser.feed('data: {"type":"done"}\r\n\r\n');
    expect(received).toEqual([
      { event: "message", data: '{"type":"delta","text":"Hello"}' },
      { event: "message", data: '{"type":"done"}' },
    ]);
  });

  it("waits for the second half of a CRLF split across chunks", () => {
    const { received, parser } = collect();
    parser.feed('data: {"type":"delta","text":"a"}\r');
    expect(received).toHaveLength(0);
    parser.feed('\n\r\ndata: {"type":"delta","text":"b"}\r\n\r\n');
    expect(received.map((message) => message.data)).toEqual([
      '{"type":"delta","text":"a"}',
      '{"type":"delta","text":"b"}',
    ]);
  });

  it("keeps event names, joins multiline data and ignores comments", () => {
    const { received, parser } = collect();
    parser.feed(': ping\n\nevent: sources\ndata: line one\ndata: line two\n\n');
    expect(received).toEqual([{ event: "sources", data: "line one\nline two" }]);
  });

  it("dispatches a trailing event on flush", () => {
    const { received, parser } = collect();
    parser.feed('data: {"type":"done"}');
    parser.flush();
    expect(received).toHaveLength(1);
  });
});

describe("parseChatEvent", () => {
  it("narrows sources, delta, done and error payloads", () => {
    expect(
      parseChatEvent(
        JSON.stringify({
          type: "sources",
          conversationId: "c1",
          retrieval: "hybrid",
          citations: [{ n: 1, passageId: 7, bookId: "b1", bookTitle: "A Book", page: 12, section: "Chapter 2" }],
        }),
      ),
    ).toMatchObject({ type: "sources", conversationId: "c1", citations: [{ n: 1, page: 12 }] });
    expect(parseChatEvent('{"type":"delta","text":"hi"}')).toEqual({ type: "delta", text: "hi" });
    expect(
      parseChatEvent(
        '{"type":"done","conversationId":"c1","messageId":"m1","title":"Title","finishReason":"length"}',
      ),
    ).toEqual({ type: "done", conversationId: "c1", messageId: "m1", title: "Title", finishReason: "length" });
    expect(parseChatEvent('{"type":"error","code":"llm_timeout","message":"Too slow"}')).toEqual({
      type: "error",
      code: "llm_timeout",
      message: "Too slow",
    });
  });

  it("ignores unknown events, malformed JSON and malformed payloads", () => {
    expect(parseChatEvent('{"type":"future"}')).toBeNull();
    expect(parseChatEvent("not json")).toBeNull();
    expect(parseChatEvent('{"type":"delta"}')).toBeNull();
    expect(parseChatEvent('{"type":"sources","conversationId":"c1"}')).toBeNull();
    expect(parseChatEvent('{"type":"error","code":"new_code","message":"x"}')).toEqual({
      type: "error",
      code: "llm_protocol",
      message: "x",
    });
  });

  it("drops citations that do not match the contract", () => {
    const event = parseChatEvent(
      JSON.stringify({
        type: "sources",
        conversationId: "c1",
        retrieval: "lexical",
        citations: [{ n: "one", bookId: "b1" }, { n: 2, passageId: 3, bookId: "b1", bookTitle: "Book", page: null, section: null }],
      }),
    );
    expect(event).toEqual({
      type: "sources",
      conversationId: "c1",
      retrieval: "lexical",
      citations: [{ n: 2, passageId: 3, bookId: "b1", bookTitle: "Book", page: null, section: null }],
    });
  });
});

// Keep a handle so the callback signature is exercised with a spy as well.
it("calls the handler with the parsed event data", () => {
  const onMessage = vi.fn();
  const parser = createSseParser(onMessage);
  parser.feed('data: {"type":"delta","text":"x"}\n\n');
  expect(onMessage).toHaveBeenCalledWith({ event: "message", data: '{"type":"delta","text":"x"}' });
});
