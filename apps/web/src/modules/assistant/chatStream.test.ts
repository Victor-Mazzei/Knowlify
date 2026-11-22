import { describe, expect, it } from "vitest";
import { openChatStream } from "./chatStream";

const encoder = new TextEncoder();

describe("openChatStream fetch fallback", () => {
  it("reads all text chunks and reports done", async () => {
    const api = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("one"));
            controller.enqueue(encoder.encode("two"));
            controller.close();
          },
        }),
      );
    const reader = await openChatStream(api, "/api/chat/messages", {});
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value ?? "");
    }
    expect(chunks.join("")).toBe("onetwo");
  });
});
