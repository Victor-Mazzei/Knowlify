import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useNavigate, Routes, Route } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { AssistantPage } from "./AssistantPage";
import { createMockChatApi } from "./mockChat";
import {
  TutorTestProviders,
  controlledStream,
  deferred,
  tutorChatStatus,
} from "./tutorHarness";

function PageNav() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/notes")}>
        Go to notes
      </button>
      <button type="button" onClick={() => navigate("/ask")}>
        Go to ask
      </button>
    </>
  );
}

function renderAssistant(api: ApiFn, status = tutorChatStatus()) {
  render(
    <TutorTestProviders api={api} status={status} initialEntries={["/ask"]}>
      <PageNav />
      <Routes>
        <Route path="/ask" element={<AssistantPage />} />
        <Route path="/notes" element={<p>notes page</p>} />
      </Routes>
    </TutorTestProviders>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AssistantPage", () => {
  it("streams an answer, starts a new session and keeps the saved one", async () => {
    renderAssistant(createMockChatApi({ seed: false, chunkDelayMs: 0 }));

    expect(await screen.findByRole("heading", { name: "Ask your library" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Start with a question" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "What do my books say about habit formation?" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "Resume session: What do my books say about habit formation?",
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "New session" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(await screen.findByRole("heading", { name: "Start with a question" })).toBeInTheDocument();
    expect(screen.queryByText(/Spaced repetition works/)).not.toBeInTheDocument();
    // Starting a new session never deletes the previous one.
    expect(
      screen.getByRole("button", {
        name: "Resume session: What do my books say about habit formation?",
      }),
    ).toBeInTheDocument();
  });

  it("stays quiet when the server has no model configured", async () => {
    const api = vi.fn(createMockChatApi({ enabled: false }));
    renderAssistant(api, tutorChatStatus({ enabled: false, model: null, host: null, scopes: { library: false, book: false } }));

    expect(await screen.findByText("Chat isn't available.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Your question" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tutor/i })).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it("explains when the library scope is off but the book scope is available", async () => {
    renderAssistant(
      createMockChatApi({ seed: false }),
      tutorChatStatus({ scopes: { library: false, book: true } }),
    );
    expect(await screen.findByText("Library chat isn't available.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Your question" })).not.toBeInTheDocument();
  });

  it("deletes a conversation after confirmation and focus returns to New", async () => {
    const chat = createMockChatApi({ chunkDelayMs: 0 });
    const deleted: string[] = [];
    renderAssistant(async (path, init) => {
      if (init?.method === "DELETE") deleted.push(path);
      return chat(path, init);
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: "Delete session?" });
    expect(dialog).toHaveTextContent("How does spaced repetition work? will be deleted.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No sessions yet/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "New session" })).toHaveFocus());
    expect(deleted).toEqual(["/api/chat/conversations/mock-1"]);
  });

  it("keeps the conversation when the delete confirmation is cancelled", async () => {
    const chat = createMockChatApi({ chunkDelayMs: 0 });
    const deleted: string[] = [];
    renderAssistant(async (path, init) => {
      if (init?.method === "DELETE") deleted.push(path);
      return chat(path, init);
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Delete session?" })).getByRole("button", {
        name: "Cancel",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    ).toBeInTheDocument();
    expect(deleted).toHaveLength(0);
  });

  it("restores the conversation and shows an inline error when deleting fails", async () => {
    const chat = createMockChatApi({ chunkDelayMs: 0 });
    renderAssistant(async (path, init) => {
      if (init?.method === "DELETE") throw new Error("The server could not delete it.");
      return chat(path, init);
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Delete session?" })).getByRole("button", {
        name: "Delete",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not delete it.");
    expect(
      await screen.findByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    ).toBeInTheDocument();
  });

  it("returns to a new conversation when the open conversation is deleted", async () => {
    renderAssistant(createMockChatApi({ chunkDelayMs: 0 }));

    fireEvent.click(await screen.findByRole("button", { name: "Resume session: How does spaced repetition work?" }));
    expect(await screen.findByText(/Spaced repetition works by revisiting/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete conversation: How does spaced repetition work?" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Delete session?" })).getByRole("button", {
        name: "Delete",
      }),
    );

    expect(await screen.findByRole("heading", { name: "Start with a question" })).toBeInTheDocument();
    expect(screen.queryByText(/Spaced repetition works by revisiting/)).not.toBeInTheDocument();
    expect(screen.getByText(/No sessions yet/)).toBeInTheDocument();
  });

  it("keeps a live conversation undeletable until its answer settles", async () => {
    const chat = createMockChatApi({ chunkDelayMs: 0 });
    const stream = controlledStream();
    const deleted: string[] = [];
    renderAssistant(async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") return stream.response(init.signal);
      if (init?.method === "DELETE") deleted.push(path);
      return chat(path, init);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Resume session: How does spaced repetition work?" }));
    expect(await screen.findByText(/Spaced repetition works by revisiting/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    const deleteButton = screen.getByRole("button", {
      name: "Delete conversation: How does spaced repetition work?",
    });
    await waitFor(() => expect(deleteButton).toBeDisabled());
    fireEvent.click(deleteButton);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deleted).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      stream.emit({ type: "sources", conversationId: "mock-1", retrieval: "hybrid", citations: [] });
      stream.emit({ type: "delta", text: "A follow-up answer." });
      stream.emit({
        type: "done",
        conversationId: "mock-1",
        messageId: "mock-follow-up",
        title: "How does spaced repetition work?",
        finishReason: "stop",
      });
      stream.close();
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument());
    await waitFor(() => expect(deleteButton).toBeEnabled());

    fireEvent.click(deleteButton);
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Delete session?" })).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("waits for a pending delete and restores the open conversation when it fails", async () => {
    const chat = createMockChatApi({ chunkDelayMs: 0 });
    const deletion = deferred<Response>();
    let deleteCalls = 0;
    renderAssistant(async (path, init) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        return deletion.promise;
      }
      return chat(path, init);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Resume session: How does spaced repetition work?" }));
    expect(await screen.findByText(/Spaced repetition works by revisiting/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete conversation: How does spaced repetition work?" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Delete session?" })).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(deleteCalls).toBe(1));

    expect(
      screen.queryByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "New session" })).toHaveFocus());

    await act(async () => deletion.reject(new Error("The server could not delete it.")));

    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not delete it.");
    expect(
      await screen.findByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toBeEnabled();
    expect(screen.getByText(/Spaced repetition works by revisiting/)).toBeInTheDocument();
  });

  it("does not abort a running answer when another conversation delete is cancelled", async () => {
    const chat = createMockChatApi({ chunkDelayMs: 0 });
    const seeded = await chat("/api/chat/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "A second question", scope: { kind: "library" } }),
    });
    await seeded.text();

    const stream = controlledStream();
    const deleted: string[] = [];
    renderAssistant(async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") return stream.response(init.signal);
      if (init?.method === "DELETE") deleted.push(path);
      return chat(path, init);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Resume session: A second question" }));
    expect(await screen.findByText(/Spaced repetition works by revisiting/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete conversation: How does spaced repetition work?" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Delete session?" })).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(deleted).toHaveLength(0);

    await act(async () => {
      stream.emit({
        type: "done",
        conversationId: "mock-conv-1",
        messageId: "mock-follow-up",
        title: "A second question",
        finishReason: "stop",
      });
      stream.close();
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    ).toBeInTheDocument();
  });

  it("keeps the conversation and the draft when navigating away and back", async () => {
    renderAssistant(createMockChatApi({ chunkDelayMs: 0 }));

    fireEvent.click(await screen.findByRole("button", { name: "Resume session: How does spaced repetition work?" }));
    expect(await screen.findByText(/Spaced repetition works by revisiting/)).toBeInTheDocument();
    const textbox = screen.getByRole("textbox", { name: "Your question" });
    fireEvent.change(textbox, { target: { value: "An unfinished draft" } });

    fireEvent.click(screen.getByRole("button", { name: "Go to notes" }));
    expect(screen.getByText("notes page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to ask" }));

    expect(await screen.findByText(/Spaced repetition works by revisiting/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("An unfinished draft");
  });

  it("keeps a stream running while the workspace is left and reopened", async () => {
    const chat = createMockChatApi({ chunkDelayMs: 0 });
    const stream = controlledStream();
    renderAssistant(async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") return stream.response(init.signal);
      return chat(path, init);
    });

    expect(await screen.findByRole("heading", { name: "Start with a question" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "A long answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Go to notes" }));
    expect(screen.getByText("notes page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to ask" }));

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await act(async () => {
      stream.emit({ type: "sources", conversationId: "mock-conv-1", retrieval: "hybrid", citations: [] });
      stream.emit({ type: "delta", text: "The answer survived." });
      stream.emit({
        type: "done",
        conversationId: "mock-conv-1",
        messageId: "m1",
        title: "A long answer",
        finishReason: "stop",
      });
      stream.close();
    });
    expect(await screen.findByText("The answer survived.")).toBeInTheDocument();
  });
});
