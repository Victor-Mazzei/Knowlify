import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { createMockChatApi } from "./mockChat";
import {
  ReaderProbe,
  TutorTestProviders,
  controlledStream,
  tutorChatStatus,
} from "./tutorHarness";

function PageNav() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/")}>
        Go to library
      </button>
      <button type="button" onClick={() => navigate("/notes")}>
        Go to notes
      </button>
      <button type="button" onClick={() => navigate("/ask")}>
        Go to ask
      </button>
      <button type="button" onClick={() => navigate("/read/b1")}>
        Go to reader
      </button>
    </>
  );
}

function renderApp(api: ApiFn, status = tutorChatStatus(), initialEntries = ["/"]) {
  render(
    <TutorTestProviders api={api} status={status} initialEntries={initialEntries}>
      <PageNav />
      <Routes>
        <Route path="/" element={<p>library page</p>} />
        <Route path="/notes" element={<p>notes page</p>} />
        <Route path="/ask" element={<h1>Ask page</h1>} />
        <Route path="/read/:id" element={<ReaderProbe />} />
      </Routes>
    </TutorTestProviders>,
  );
}

const answerEvents = (conversationId = "c1") => [
  { type: "sources", conversationId, retrieval: "hybrid", citations: [] },
  { type: "delta", text: "An answer." },
  { type: "done", conversationId, messageId: "m1", title: "Question", finishReason: "stop" },
];

afterEach(() => vi.unstubAllGlobals());

describe("TutorDock", () => {
  it("opens and closes with the FAB and Alt+T, keeping focus on the entry point", async () => {
    renderApp(createMockChatApi({ seed: false }));

    const fab = await screen.findByRole("button", { name: "Open tutor" });
    expect(fab).toHaveAttribute("aria-keyshortcuts", "Alt+T");
    fab.focus();
    fireEvent.click(fab);

    expect(await screen.findByRole("complementary", { name: "Tutor" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Whole library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide tutor" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "T", code: "KeyT", altKey: true });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Tutor" })).not.toBeInTheDocument(),
    );
    expect(fab).toHaveFocus();

    fireEvent.keyDown(document, { key: "T", code: "KeyT", altKey: true });
    expect(await screen.findByRole("complementary", { name: "Tutor" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Tutor" })).not.toBeInTheDocument(),
    );
  });

  it("closes from the composer with Alt+T and restores the opener", async () => {
    renderApp(createMockChatApi({ seed: false }));
    const fab = await screen.findByRole("button", { name: "Open tutor" });
    fab.focus();
    fireEvent.click(fab);
    const textbox = await screen.findByRole("textbox", { name: "Your question" });
    await waitFor(() => expect(textbox).toHaveFocus());

    fireEvent.keyDown(textbox, { key: "T", code: "KeyT", altKey: true });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Tutor" })).not.toBeInTheDocument(),
    );
    expect(fab).toHaveFocus();
  });

  it("hides entirely when chat is disabled, including the shortcut", async () => {
    renderApp(
      createMockChatApi({ enabled: false }),
      tutorChatStatus({ enabled: false, model: null, host: null, scopes: { library: false, book: false } }),
    );
    expect(screen.queryByRole("button", { name: "Open tutor" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "T", code: "KeyT", altKey: true });
    expect(screen.queryByRole("complementary", { name: "Tutor" })).not.toBeInTheDocument();
  });

  it("is absent on /ask, where the same workspace is already on screen", async () => {
    renderApp(createMockChatApi({ seed: false }), tutorChatStatus(), ["/ask"]);
    expect(await screen.findByRole("heading", { name: "Ask page" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open tutor" })).not.toBeInTheDocument();
  });

  it("does not show the FAB in the reader", async () => {
    renderApp(createMockChatApi({ seed: false }), tutorChatStatus(), ["/read/b1"]);
    expect(await screen.findByText("Book b1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open tutor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide tutor" })).not.toBeInTheDocument();
  });

  it("keeps the draft and the conversation across routes", async () => {
    renderApp(createMockChatApi({ seed: false, chunkDelayMs: 0 }));
    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));

    const textbox = await screen.findByRole("textbox", { name: "Your question" });
    fireEvent.change(textbox, { target: { value: "An unfinished draft" } });

    fireEvent.click(screen.getByRole("button", { name: "Go to notes" }));
    expect(screen.getByText("notes page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to library" }));

    expect(await screen.findByRole("textbox", { name: "Your question" })).toHaveValue("An unfinished draft");
    expect(screen.getByRole("complementary", { name: "Tutor" })).toBeInTheDocument();
  });

  it("keeps the draft through the reader and back", async () => {
    renderApp(createMockChatApi({ seed: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Your question" }), {
      target: { value: "A draft before reading" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Go to reader" }));
    expect(await screen.findByText("Book b1")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("A draft before reading");
    expect(screen.getByRole("button", { name: "This book" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Go to library" }));
    expect(await screen.findByText("library page")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("A draft before reading");
    expect(screen.queryByRole("button", { name: "This book" })).not.toBeInTheDocument();
  });

  it("returns focus to the reader toolbar when the original opener is gone", async () => {
    renderApp(createMockChatApi({ seed: false }));
    const fab = await screen.findByRole("button", { name: "Open tutor" });
    fab.focus();
    fireEvent.click(fab);
    await screen.findByRole("complementary", { name: "Tutor" });

    fireEvent.click(screen.getByRole("button", { name: "Go to reader" }));
    expect(await screen.findByText("Book b1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open tutor" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Tutor" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Reader tutor" })).toHaveFocus();
  });

  it("does not abort a running answer when closed and navigated away", async () => {
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const stream = controlledStream();
    let aborted = false;
    const api: ApiFn = async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return stream.response(init.signal);
      }
      return chat(path, init);
    };
    renderApp(api);

    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Your question" }), {
      target: { value: "A long answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Go to notes" }));
    expect(screen.getByText("notes page")).toBeInTheDocument();
    expect(aborted).toBe(false);

    await act(async () => {
      stream.emit({ type: "sources", conversationId: "c1", retrieval: "hybrid", citations: [] });
      stream.emit({ type: "delta", text: "The answer survived." });
      stream.emit({ type: "done", conversationId: "c1", messageId: "m1", title: "A long answer", finishReason: "stop" });
      stream.close();
    });
    expect(aborted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Go to library" }));
    fireEvent.keyDown(document, { key: "T", code: "KeyT", altKey: true });
    expect(await screen.findByText("The answer survived.")).toBeInTheDocument();
  });

  it("starts a new chat by deleting the saved conversation", async () => {
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const deleted: string[] = [];
    renderApp(async (path, init) => {
      if (init?.method === "DELETE") deleted.push(path);
      return chat(path, init);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Your question" }), {
      target: { value: "First question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Start a new chat?" });
    expect(dialog).toHaveTextContent("Your conversation about your library will be deleted.");
    fireEvent.click(within(dialog).getByRole("button", { name: "New chat" }));

    expect(await screen.findByRole("heading", { name: "Start with a question" })).toBeInTheDocument();
    expect(screen.queryByText(/Spaced repetition works/)).not.toBeInTheDocument();
    await waitFor(() => expect(deleted).toEqual(["/api/chat/conversations/mock-conv-1"]));
  });

  it("keeps the chat, the draft and focus when New chat cannot delete", async () => {
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    renderApp(async (path, init) => {
      if (init?.method === "DELETE") throw new Error("The conversation could not be deleted.");
      return chat(path, init);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
    const textbox = await screen.findByRole("textbox", { name: "Your question" });
    fireEvent.change(textbox, { target: { value: "First question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled());
    fireEvent.change(textbox, { target: { value: "An unfinished draft" } });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Start a new chat?" })).getByRole("button", {
        name: "New chat",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The conversation could not be deleted.");
    expect(screen.getByText(/Spaced repetition works/)).toBeInTheDocument();
    expect(textbox).toHaveValue("An unfinished draft");
    await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toHaveFocus());
  });

  it("shows the 20 most recent conversations for the active scope and opens one", async () => {
    renderApp(createMockChatApi({ chunkDelayMs: 0 }));
    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));

    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Recent conversations")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^How does spaced repetition work\?/ }));
    expect(await screen.findByText(/Spaced repetition works by revisiting/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
  });

  it("mentions the provider host in the privacy notice", async () => {
    renderApp(createMockChatApi({ seed: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
    expect(await screen.findByText(/sent to/)).toBeInTheDocument();
    expect(screen.getByText("api.example.test")).toBeInTheDocument();
  });

  it("uses a modal dialog with a focus trap on mobile", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width: 767"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    renderApp(createMockChatApi({ seed: false }));

    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
    const dialog = await screen.findByRole("dialog", { name: "Tutor" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.getElementById("tutor-main")).toHaveAttribute("inert");

    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((element) => !element.closest("[hidden]"));
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tutor" })).not.toBeInTheDocument());
    expect(document.getElementById("tutor-main")).not.toHaveAttribute("inert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Open tutor" })).toHaveFocus());
  });

  it("deletes a conversation from the dock history with confirmation", async () => {
    renderApp(createMockChatApi({ chunkDelayMs: 0 }));
    fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
    fireEvent.click(await screen.findByRole("button", { name: "History" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete conversation: How does spaced repetition work?" }),
    );
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Delete conversation?" })).getByRole("button", {
        name: "Delete",
      }),
    );

    await waitFor(() => expect(screen.getByText(/No conversations yet/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "New chat" })).toHaveFocus());
  });
});
