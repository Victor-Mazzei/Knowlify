import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList";
import type { ChatMessage } from "./types";

const messages: ChatMessage[] = [
  { id: "u1", role: "user", content: "A question", citations: null, createdAt: 1 },
  { id: "a1", role: "assistant", content: "An answer", citations: null, createdAt: 2 },
];

const renderList = (list: ChatMessage[], streaming: boolean) =>
  render(
    <MessageList
      messages={list}
      streaming={streaming}
      examples={[]}
      emptyTitle="Empty"
      onExample={() => undefined}
    />,
  );

describe("MessageList", () => {
  it("is a polite log so answers are announced without interrupting", () => {
    renderList(messages, false);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveTextContent("A question");
    expect(log).toHaveTextContent("An answer");
  });

  it("shows the status spinner while the tutor is answering and removes it afterwards", () => {
    const pending: ChatMessage[] = [
      { id: "u1", role: "user", content: "A question", citations: null, createdAt: 1 },
      { id: "local-1", role: "assistant", content: "", citations: null, createdAt: 2 },
    ];
    const { rerender } = renderList(pending, true);

    expect(screen.getByRole("status")).toHaveTextContent("The tutor is answering");
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();

    rerender(
      <MessageList messages={pending} streaming={false} examples={[]} emptyTitle="Empty" onExample={() => undefined} />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the small spinner beside streamed text instead of a Writing… label", () => {
    const streaming: ChatMessage[] = [
      { id: "u1", role: "user", content: "A question", citations: null, createdAt: 1 },
      { id: "local-1", role: "assistant", content: "An answer so far", citations: null, createdAt: 2 },
    ];
    renderList(streaming, true);

    expect(screen.getByRole("status")).toHaveTextContent("The tutor is answering");
    expect(screen.queryByText("Writing…")).not.toBeInTheDocument();
  });

  it("marks a kept partial answer as incomplete", () => {
    renderList(
      [
        { id: "u1", role: "user", content: "A question", citations: null, createdAt: 1 },
        { id: "a1", role: "assistant", content: "Half an answer", citations: null, createdAt: 2, incomplete: true },
      ],
      false,
    );
    expect(screen.getByText("Answer incomplete.")).toBeInTheDocument();
  });

  it("does not animate the spinner when the user prefers reduced motion", () => {
    const css = readFileSync("src/modules/assistant/assistant.css", "utf8");
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf("@media", start + 1));
    expect(block).toContain(".asst-spinner-ring { display: none; animation: none; }");
    expect(block).toContain(".asst-spinner-dots > span");
    expect(block).not.toMatch(/animation:\s*asst-spinner/);
  });
});
