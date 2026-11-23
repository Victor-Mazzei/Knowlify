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

  it("shows three thinking dots while the answer is pending and removes them afterwards", () => {
    const pending: ChatMessage[] = [
      { id: "u1", role: "user", content: "A question", citations: null, createdAt: 1 },
      { id: "local-1", role: "assistant", content: "", citations: null, createdAt: 2 },
    ];
    const { container, rerender } = renderList(pending, true);

    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(container.querySelectorAll(".asst-status-dots > span")).toHaveLength(3);
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();

    rerender(
      <MessageList messages={pending} streaming={false} examples={[]} emptyTitle="Empty" onExample={() => undefined} />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("drops the dots once answer text streams and keeps no fixed visible label", () => {
    const streaming: ChatMessage[] = [
      { id: "u1", role: "user", content: "A question", citations: null, createdAt: 1 },
      { id: "local-1", role: "assistant", content: "An answer so far", citations: null, createdAt: 2 },
    ];
    const { container } = renderList(streaming, true);

    expect(screen.getByRole("status")).toHaveTextContent("Writing");
    expect(container.querySelector(".asst-status-dots")).toBeNull();
    expect(screen.queryByText("Writing…")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
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
});
