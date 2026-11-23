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
    expect(
      parseChatEvent('{"type":"error","code":"llm_empty","message":"The language model returned no answer"}'),
    ).toEqual({
      type: "error",
      code: "llm_empty",
      message: "The language model returned no answer",
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

  it("parses the additive mode fields and the null Ask conversation id", () => {
    expect(
      parseChatEvent(
        JSON.stringify({
          type: "sources",
          conversationId: null,
          retrieval: "none",
          citations: [],
          mode: "ask",
          persisted: false,
          useLibrary: false,
        }),
      ),
    ).toEqual({
      type: "sources",
      conversationId: null,
      retrieval: "none",
      citations: [],
      mode: "ask",
      persisted: false,
      useLibrary: false,
    });
    expect(
      parseChatEvent(
        JSON.stringify({
          type: "done",
          conversationId: null,
          messageId: "m1",
          title: "",
          finishReason: "stop",
          mode: "ask",
          persisted: false,
        }),
      ),
    ).toEqual({
      type: "done",
      conversationId: null,
      messageId: "m1",
      title: "",
      finishReason: "stop",
      mode: "ask",
      persisted: false,
    });
    expect(
      parseChatEvent(
        '{"type":"sources","conversationId":"c1","retrieval":"none","citations":[],"mode":"future"}',
      ),
    ).toEqual({ type: "sources", conversationId: "c1", retrieval: "none", citations: [] });
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

  it("parses the additive recommendations event and the done marker list", () => {
    const event = parseChatEvent(
      JSON.stringify({
        type: "recommendations",
        status: "ready",
        intent: "explicit",
        focus: "recommend",
        books: [
          {
            n: 1,
            bookId: "b1",
            title: "Rust for Web Developers",
            author: "Mara Klein",
            format: "epub",
            language: "en",
            hasCover: true,
            coverRev: 4,
            progress: { status: "reading", percentage: 0.34 },
            matched: ["rust", "web"],
            evidence: [{ passageId: 9, page: 12, section: "Requests" }],
            source: "both",
          },
          { n: 2, bookId: "b2" },
        ],
      }),
    );
    expect(event).toEqual({
      type: "recommendations",
      status: "ready",
      intent: "explicit",
      focus: "recommend",
      books: [
        {
          n: 1,
          bookId: "b1",
          title: "Rust for Web Developers",
          author: "Mara Klein",
          format: "epub",
          language: "en",
          hasCover: true,
          coverRev: 4,
          progress: { status: "reading", percentage: 0.34 },
          matched: ["rust", "web"],
          evidence: [{ passageId: 9, page: 12, section: "Requests" }],
          source: "both",
        },
      ],
    });
    expect(
      parseChatEvent(
        '{"type":"done","conversationId":null,"messageId":"m1","title":"","finishReason":"stop","recommended":[2,1,2]}',
      ),
    ).toMatchObject({ type: "done", recommended: [2, 1, 2] });
    expect(parseChatEvent('{"type":"recommendations","status":"future"}')).toBeNull();
  });

  it("keeps an unknown event type from a newer server out of the transcript", () => {
    expect(parseChatEvent('{"type":"book_cards","books":[]}')).toBeNull();
  });

  it("maps the post-stream conversation_limit error to its own code", () => {
    expect(
      parseChatEvent(
        '{"type":"error","code":"conversation_limit","message":"You reached the session limit."}',
      ),
    ).toEqual({
      type: "error",
      code: "conversation_limit",
      message: "You reached the session limit.",
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
