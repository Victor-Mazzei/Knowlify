import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { ChatPanel } from "./ChatPanel";
import { createMockChatApi } from "./mockChat";
import type { ChatStatus } from "./types";

const status: ChatStatus = {
  enabled: true,
  model: "deepseek-v4.1-flash",
  host: "api.deepseek.com",
  promptVersion: "feynman-1",
  scopes: { library: true, book: true },
};

const renderPanel = (api = createMockChatApi({ seed: false, chunkDelayMs: 0 }), onConversation = vi.fn()) =>
  render(
    <MemoryRouter>
      <ChatPanel
        api={api}
        status={status}
        scope={{ kind: "library" }}
        onConversation={onConversation}
        label="Chat with your library"
        examples={["First example?", "Second example?", "Third example?"]}
        emptyTitle="Start with a question"
        emptyCopy="Ask about your books."
      />
    </MemoryRouter>,
  );

describe("ChatPanel", () => {
  it("shows the empty state, examples and the privacy note, and focuses the field", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Start with a question" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "First example?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second example?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Third example?" })).toBeInTheDocument();
    expect(screen.getByText(/Your question and the retrieved passages are sent to/)).toHaveTextContent(
      "api.deepseek.com",
    );
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Second example?" }));
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("Second example?");
  });

  it("streams an answer with citation links and reports the new conversation", async () => {
    const onConversation = vi.fn();
    renderPanel(createMockChatApi({ seed: false, chunkDelayMs: 0 }), onConversation);

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "How does it work?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();
    // The answer streams in chunks and the first one matches the regex above before
    // the "[1]" marker (and its inline link) arrives. Wait for the stream to settle
    // so the assertions below see the final DOM instead of a mid-stream frame.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Source 1: The Art of Memory, page 42/ })).toHaveAttribute(
      "href",
      "/read/mock-book?at=42",
    );
    expect(screen.getByText("2 sources")).toBeInTheDocument();
    expect(screen.getByText("How does it work?")).toBeInTheDocument();
    await waitFor(() => expect(onConversation).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "library" } })));
  });

  it("offers Stop during a stream and Retry after stopping", async () => {
    renderPanel(createMockChatApi({ seed: false, chunkDelayMs: 25 }));

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Explain." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByText("Answer stopped.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("shows an inline stream error with Retry and keeps the partial answer", async () => {
    renderPanel(createMockChatApi({ seed: false, chunkDelayMs: 0, scenario: "timeout" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Explain." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The model took too long to answer. Try again.");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Let me think about that")).toBeInTheDocument();
    expect(screen.getByText("Answer incomplete.")).toBeInTheDocument();
  });

  it("shows an HTTP error from the server inline", async () => {
    renderPanel(createMockChatApi({ seed: false, scenario: "rate-limited" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Explain." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many messages. Try again in a minute.");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("blocks a full session and offers a new one without losing the question", async () => {
    const detail = {
      id: "c1",
      title: "Full",
      scope: { kind: "library" },
      messages: [
        { id: "m1", role: "user", content: "Old question", citations: null, createdAt: 1 },
        { id: "m2", role: "assistant", content: "Old answer", citations: null, createdAt: 2 },
      ],
    };
    const api: ApiFn = async (_path, init) => {
      if (init?.method === "POST") {
        throw new ApiError(409, "This session is full. Start a new one.", "conversation_full");
      }
      return new Response(JSON.stringify(detail), { headers: { "Content-Type": "application/json" } });
    };
    const onStartNewSession = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel
          api={api}
          status={status}
          scope={{ kind: "library" }}
          conversationId="c1"
          label="Chat with your library"
          examples={[]}
          emptyTitle="Start"
          onStartNewSession={onStartNewSession}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Old answer")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
      target: { value: "One more" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("This session is full. Start a new session.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("One more");
    expect(screen.queryByText("One more", { selector: ".asst-question" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    expect(onStartNewSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the fixed answer when retrieval found no passages", async () => {
    renderPanel(createMockChatApi({ seed: false, chunkDelayMs: 0, scenario: "no-passages" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Unknown topic?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/I couldn't find passages about this in your library yet/)).toBeInTheDocument();
    expect(screen.queryByText("2 sources")).not.toBeInTheDocument();
  });
});
