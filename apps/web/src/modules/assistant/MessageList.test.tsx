import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { MessageList } from "./MessageList";
import type { ChatMessage, RecommendedBook } from "./types";

const api: ApiFn = async () => new Response(null, { status: 204 });

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
      api={api}
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
      <MessageList
        messages={pending}
        streaming={false}
        examples={[]}
        emptyTitle="Empty"
        onExample={() => undefined}
        api={api}
      />,
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

  it("formats the assistant answer but keeps the question as plain text", () => {
    const list: ChatMessage[] = [
      { id: "u1", role: "user", content: "**not bold**", citations: null, createdAt: 1 },
      { id: "a1", role: "assistant", content: "**bold**", citations: null, createdAt: 2 },
    ];
    renderList(list, false);
    expect(screen.getByText("**not bold**")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
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

  it("links a [book:n] marker only when done.recommended validated it", () => {
    const books: RecommendedBook[] = [
      {
        n: 1,
        bookId: "b1",
        title: "Rust for Web Developers",
        author: "Mara Klein",
        format: "epub",
        language: "en",
        hasCover: false,
        coverRev: null,
        progress: { status: "unread", percentage: 0 },
        matched: ["rust"],
        evidence: [],
        source: "passages",
      },
      {
        n: 2,
        bookId: "b2",
        title: "Not Mentioned",
        author: "Some Author",
        format: "pdf",
        language: "en",
        hasCover: false,
        coverRev: null,
        progress: { status: "unread", percentage: 0 },
        matched: [],
        evidence: [],
        source: "metadata",
      },
    ];
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Which books?", citations: null, createdAt: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "Try [book:1] but not [book:2].",
        citations: null,
        createdAt: 2,
        recommendations: { status: "ready", intent: "detected", focus: "recommend", books },
        recommended: [1],
      },
    ];
    render(
      <MemoryRouter>
        <MessageList
          messages={messages}
          streaming={false}
          examples={[]}
          emptyTitle="Empty"
          onExample={() => undefined}
          api={api}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getAllByRole("link", { name: "Open Rust for Web Developers by Mara Klein" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/\[book:2\]/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Not Mentioned/ })).not.toBeInTheDocument();
  });
});
