import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList";
import type { ChatMessage } from "./types";

const messages: ChatMessage[] = [
  { id: "u1", role: "user", content: "A question", citations: null, createdAt: 1 },
  { id: "a1", role: "assistant", content: "An answer", citations: null, createdAt: 2 },
];

describe("MessageList", () => {
  it("is a polite log so answers are announced without interrupting", () => {
    render(
      <MessageList
        messages={messages}
        streaming={false}
        examples={[]}
        emptyTitle="Empty"
        onExample={() => undefined}
      />,
    );
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveTextContent("A question");
    expect(log).toHaveTextContent("An answer");
  });
});
