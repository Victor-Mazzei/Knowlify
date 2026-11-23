import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { TUTOR_ASK_LIBRARY_KEY, TUTOR_MODE_KEY } from "../../services/storage";
import { createMockChatApi } from "./mockChat";
import { LIBRARY_SLOT_KEY, TutorProvider, useTutor } from "./TutorProvider";
import { ReaderProbe, TutorTestProviders, chatStatusContext, tutorChatStatus } from "./tutorHarness";
import type { ChatMessage, ChatStatus } from "./types";
import { ChatStatusContext } from "./useChatStatus";

type Body = Record<string, unknown>;

function renderTutor(
  api: ApiFn,
  status: ChatStatus = tutorChatStatus(),
  initialEntries = ["/"],
) {
  render(
    <TutorTestProviders api={api} status={status} initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<p>library page</p>} />
        <Route path="/read/:id" element={<ReaderProbe bookId="a" title="Book a" />} />
        <Route path="/settings/ai" element={<p>AI settings</p>} />
      </Routes>
    </TutorTestProviders>,
  );
}

const openDock = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
};

const askRadio = () => screen.getByRole("radio", { name: "Ask" });
const sessionRadio = () => screen.getByRole("radio", { name: "Session" });
const librarySwitch = () => screen.getByRole("switch", { name: "Use my library" });
const questionBox = () => screen.getByRole("textbox", { name: "Your question" });

const announcement = () =>
  screen
    .getAllByRole("status")
    .map((element) => element.textContent ?? "")
    .join(" | ");

const postBodies = () => {
  const bodies: Body[] = [];
  const imports: Body[] = [];
  const deletes: string[] = [];
  return { bodies, imports, deletes };
};

const askTranscript = (turns: number): ChatMessage[] =>
  Array.from({ length: turns * 2 }, (_, index) => ({
    id: `ask-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content:
      index % 2 === 0 ? `Question ${index / 2 + 1}` : `Answer ${(index - 1) / 2 + 1}`,
    citations: null,
    createdAt: index,
  }));

/** Drives the provider guard with a transcript instead of streaming ten real turns. */
function TranscriptProbe({ messages }: { messages: ChatMessage[] }) {
  const tutor = useTutor();
  const opened = useRef(false);
  const register = tutor.registerTranscript;
  const open = tutor.openTutor;
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    open();
  }, [open]);
  useEffect(() => register(LIBRARY_SLOT_KEY, () => messages), [register, messages]);
  return (
    <button type="button" onClick={tutor.startNewSession}>
      Start a new session
    </button>
  );
}

function AskImportHarness({ api, messages }: { api: ApiFn; messages: ChatMessage[] }) {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <ChatStatusContext.Provider value={chatStatusContext(tutorChatStatus())}>
        <TutorProvider credentials={{ user: "reader", pass: "secret" }} onLogout={() => undefined} api={api}>
          <TranscriptProbe messages={messages} />
        </TutorProvider>
      </ChatStatusContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => localStorage.clear());

describe("Tutor modes", () => {
  it("sends Ask without a conversation and with the visible library choice", async () => {
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const { bodies, imports } = postBodies();
    const api: ApiFn = async (path, init) => {
      if (path === "/api/chat/conversations" && init?.method === "POST") {
        imports.push(JSON.parse(String(init.body)) as Body);
      }
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    renderTutor(api);
    await openDock();

    expect(screen.getByText("Quick question: nothing is saved")).toBeVisible();
    expect(screen.getByText("Keeps the history and context; you can resume later")).toBeVisible();
    fireEvent.click(askRadio());
    expect(screen.getByText(/Ask · not saved · library on/)).toBeInTheDocument();
    expect(librarySwitch()).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getAllByText("Ask with your library: answers can cite your books.").length,
    ).toBeGreaterThan(0);
    expect(localStorage.getItem(TUTOR_MODE_KEY)).toBe("ask");

    fireEvent.change(questionBox(), { target: { value: "A quick question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();

    expect(bodies[0]).toMatchObject({
      message: "A quick question",
      mode: "ask",
      useLibrary: true,
      scope: { kind: "library" },
    });
    expect(bodies[0]).not.toHaveProperty("conversationId");
    expect(imports).toEqual([]);
    expect(screen.queryByText(/^Session · saved/)).not.toBeInTheDocument();
    await waitFor(() => expect(librarySwitch()).toBeEnabled());

    fireEvent.click(librarySwitch());
    expect(screen.getByText(/Ask · not saved · library off/)).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Ask without your library: the model answers on its own, no citations. Your books are not searched or sent.",
      ).length,
    ).toBeGreaterThan(0);
    expect(localStorage.getItem(TUTOR_ASK_LIBRARY_KEY)).toBe("0");
    expect(Object.keys(localStorage).sort()).toEqual([TUTOR_ASK_LIBRARY_KEY, TUTOR_MODE_KEY].sort());

    fireEvent.change(questionBox(), { target: { value: "A private question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/A useful first experiment/)).toBeInTheDocument();
    expect(bodies[1]).toMatchObject({ mode: "ask", useLibrary: false });
    // Only the first answer (with the library on) carries citations; the private one has none.
    expect(screen.getAllByText("2 sources")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /Source 1/ })).toHaveLength(1);

    // Neither Ask turn created a saved conversation.
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(await screen.findByText(/No sessions yet/)).toBeInTheDocument();
  });

  it("saves an Ask chat as a session when the mode changes", async () => {
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const { imports } = postBodies();
    const api: ApiFn = async (path, init) => {
      if (path === "/api/chat/conversations" && init?.method === "POST") {
        imports.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    renderTutor(api);
    await openDock();
    fireEvent.click(askRadio());
    fireEvent.change(questionBox(), { target: { value: "Keep this question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();

    fireEvent.click(sessionRadio());
    const dialog = await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save as session" }));

    await waitFor(() => expect(imports).toHaveLength(1));
    expect(imports[0]).toMatchObject({ scope: { kind: "library" } });
    expect(imports[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Keep this question" }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("Spaced repetition") }),
    ]);
    expect(await screen.findByText("Session · saved · Keep this question")).toBeInTheDocument();
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();
    expect(sessionRadio()).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(
      await screen.findByRole("button", { name: "Resume session: Keep this question" }),
    ).toBeInTheDocument();
  });

  it("blocks Save as session when the whole Ask transcript exceeds the import limit", async () => {
    localStorage.setItem(TUTOR_MODE_KEY, "ask");
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const imports: Body[] = [];
    const api: ApiFn = async (path, init) => {
      if (path === "/api/chat/conversations" && init?.method === "POST") {
        imports.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    render(<AskImportHarness api={api} messages={askTranscript(11)} />);

    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    const dialog = await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "This chat has 22 messages. A session can hold at most 20, so Save as session is not available.",
    );
    expect(within(dialog).getByRole("alert")).not.toHaveTextContent("nothing was saved");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "the 2 oldest messages will not be saved.",
    );
    expect(within(dialog).getByRole("button", { name: "Save as session" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save last 20 messages" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Discard" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "This Ask chat is not saved." })).not.toBeInTheDocument(),
    );
    expect(imports).toEqual([]);
    // Cancel kept the whole Ask chat: asking to leave again reopens the same warning.
    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    expect(
      await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." }),
    ).toHaveTextContent("This chat has 22 messages");
    expect(imports).toEqual([]);
  });

  it("saves only the newest 20 messages when the explicit opt-in is chosen", async () => {
    localStorage.setItem(TUTOR_MODE_KEY, "ask");
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const imports: Body[] = [];
    const api: ApiFn = async (path, init) => {
      if (path === "/api/chat/conversations" && init?.method === "POST") {
        imports.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    render(<AskImportHarness api={api} messages={askTranscript(11)} />);

    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    const dialog = await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "the 2 oldest messages will not be saved.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save last 20 messages" }));

    await waitFor(() => expect(imports).toHaveLength(1));
    const messages = imports[0]?.messages as Body[];
    expect(messages).toHaveLength(20);
    expect(messages.map((message) => message.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => [
        `Question ${index + 2}`,
        `Answer ${index + 2}`,
      ]).flat(),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "This Ask chat is not saved." })).not.toBeInTheDocument(),
    );
  });

  it("blocks a transcript that is not a question-and-answer sequence", async () => {
    localStorage.setItem(TUTOR_MODE_KEY, "ask");
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const messages: ChatMessage[] = [
      { id: "q1", role: "user", content: "First question", citations: null, createdAt: 1 },
      { id: "q2", role: "user", content: "Second question", citations: null, createdAt: 2 },
      { id: "a1", role: "assistant", content: "One answer", citations: null, createdAt: 3 },
    ];
    render(<AskImportHarness api={chat} messages={messages} />);

    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    const dialog = await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "This chat is not a question-and-answer sequence, so it cannot be saved as a session.",
    );
    expect(within(dialog).getByRole("button", { name: "Save as session" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("imports all 20 messages when the Ask transcript is exactly at the import limit", async () => {
    localStorage.setItem(TUTOR_MODE_KEY, "ask");
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const imports: Body[] = [];
    const api: ApiFn = async (path, init) => {
      if (path === "/api/chat/conversations" && init?.method === "POST") {
        imports.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    render(<AskImportHarness api={api} messages={askTranscript(10)} />);

    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    const dialog = await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save as session" }));

    await waitFor(() => expect(imports).toHaveLength(1));
    expect(imports[0]).toMatchObject({ scope: { kind: "library" } });
    const messages = imports[0]?.messages as Body[];
    expect(messages).toHaveLength(20);
    expect(messages.map((message) => message.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => [
        `Question ${index + 1}`,
        `Answer ${index + 1}`,
      ]).flat(),
    );
    expect(messages[0]).toEqual(expect.objectContaining({ role: "user", content: "Question 1" }));
    expect(messages[19]).toEqual(expect.objectContaining({ role: "assistant", content: "Answer 10" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "This Ask chat is not saved." })).not.toBeInTheDocument(),
    );
  });

  it("warns that a partial answer is saved exactly as shown", async () => {
    localStorage.setItem(TUTOR_MODE_KEY, "ask");
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const messages = askTranscript(2);
    const partial = messages.map((message, index) =>
      index === 1 ? { ...message, incomplete: true } : message,
    );
    render(<AskImportHarness api={chat} messages={partial} />);

    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    const dialog = await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." });
    expect(
      within(dialog).getByText("The session will include 1 partial answer exactly as it appears."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save as session" })).toBeEnabled();
  });

  it("keeps the save dialog open when the import reaches the session limit", async () => {
    const chat = createMockChatApi({ seed: true, maxSessions: 1, chunkDelayMs: 0 });
    renderTutor(
      chat,
      tutorChatStatus({ sessionLimits: { maxSessions: 1, count: 0, maxMessages: 100 } }),
    );
    await openDock();
    fireEvent.click(askRadio());
    fireEvent.change(questionBox(), { target: { value: "Save me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();
    await waitFor(() => expect(sessionRadio()).toBeEnabled());

    fireEvent.click(sessionRadio());
    const dialog = await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save as session" }));

    const current = screen.getByRole("alertdialog", { name: "This Ask chat is not saved." });
    expect(await within(current).findByRole("alert")).toHaveTextContent("the limit is 1");
    expect(within(current).getByRole("button", { name: "Save as session" })).toBeInTheDocument();
    expect(askRadio()).toBeChecked();
  });

  it("discards or keeps the Ask chat from the warning", async () => {
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const { imports } = postBodies();
    const api: ApiFn = async (path, init) => {
      if (path === "/api/chat/conversations" && init?.method === "POST") {
        imports.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    renderTutor(api);
    await openDock();
    fireEvent.click(askRadio());
    fireEvent.change(questionBox(), { target: { value: "Discard me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();

    fireEvent.click(sessionRadio());
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." })).getByRole(
        "button",
        { name: "Cancel" },
      ),
    );
    expect(askRadio()).toBeChecked();
    expect(screen.getByText(/Spaced repetition works/)).toBeInTheDocument();

    fireEvent.click(sessionRadio());
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." })).getByRole(
        "button",
        { name: "Discard" },
      ),
    );
    expect(await screen.findByRole("heading", { name: "Start with a question" })).toBeInTheDocument();
    expect(screen.queryByText(/Spaced repetition works/)).not.toBeInTheDocument();
    expect(sessionRadio()).toBeChecked();
    expect(imports).toEqual([]);
  });

  it("stays Session only against a server without modes", async () => {
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0, modes: false });
    const bodies: Body[] = [];
    const api: ApiFn = async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    renderTutor(
      api,
      tutorChatStatus({ modes: undefined, sessionLimits: undefined }),
    );
    await openDock();

    expect(screen.queryByRole("radiogroup", { name: "Chat mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Ask" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Use my library" })).not.toBeInTheDocument();
    expect(screen.getByText("New session · saves with your first answer")).toBeInTheDocument();

    fireEvent.change(questionBox(), { target: { value: "Legacy turn" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();

    expect(bodies[0]).not.toHaveProperty("mode");
    expect(bodies[0]).not.toHaveProperty("useLibrary");
    expect(await screen.findByText("Session · saved · Legacy turn")).toBeInTheDocument();
  });

  it("disables a new Session at the limit and leaves Ask and existing sessions free", async () => {
    const status = tutorChatStatus({
      sessionLimits: { maxSessions: 2, count: 2, maxMessages: 100 },
    });
    renderTutor(createMockChatApi({ chunkDelayMs: 0 }), status);
    await openDock();

    expect(await screen.findByText(/You reached the session limit \(2\)/)).toBeInTheDocument();
    expect(questionBox()).toBeDisabled();
    expect(screen.getByRole("link", { name: "Settings → AI" })).toHaveAttribute("href", "/settings/ai");

    fireEvent.click(askRadio());
    expect(questionBox()).toBeEnabled();

    fireEvent.click(sessionRadio());
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(await screen.findByText("2 of 2 sessions saved on this server.")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Resume session: How does spaced repetition work?" }),
    );
    await waitFor(() => expect(questionBox()).toBeEnabled());
    expect(screen.queryByText(/You reached the session limit/)).not.toBeInTheDocument();
  });

  it("turns a 409 conversation_limit into the same blocked composer", async () => {
    const chat = createMockChatApi({ seed: true, maxSessions: 1, chunkDelayMs: 0 });
    renderTutor(
      chat,
      tutorChatStatus({ sessionLimits: { maxSessions: 1, count: 0, maxMessages: 100 } }),
    );
    await openDock();

    fireEvent.change(questionBox(), { target: { value: "One too many" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/You reached the session limit \(1\)/)).toBeInTheDocument();
    await waitFor(() => expect(questionBox()).toBeDisabled());
    expect(questionBox()).toHaveValue("One too many");
    expect(screen.queryByText("One too many", { selector: ".asst-question" })).not.toBeInTheDocument();

    fireEvent.click(askRadio());
    expect(questionBox()).toBeEnabled();
  });

  it("resumes the last session of the book and New session never deletes it", async () => {
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const deleted: string[] = [];
    await chat("/api/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: { kind: "book", bookId: "a" },
        title: "Saved in the book",
        messages: [
          { role: "user", content: "Remember this" },
          { role: "assistant", content: "A remembered answer." },
        ],
      }),
    });
    const api: ApiFn = async (path, init) => {
      if (init?.method === "DELETE") deleted.push(path);
      return chat(path, init);
    };
    renderTutor(api, tutorChatStatus(), ["/read/a"]);
    fireEvent.click(await screen.findByRole("button", { name: "Reader tutor" }));

    const banner = await screen.findByText(/Resuming:/);
    expect(banner).toHaveTextContent("Resuming: Saved in the book");
    expect(await screen.findByText("A remembered answer.")).toBeInTheDocument();
    fireEvent.click(within(banner.closest("p") as HTMLElement).getByRole("button", { name: "New session" }));

    expect(
      await screen.findByRole("heading", { name: "Start with the passage in front of you." }),
    ).toBeInTheDocument();
    expect(screen.queryByText("A remembered answer.")).not.toBeInTheDocument();
    expect(deleted).toEqual([]);
  });

  it("lists book and library sessions, renames inline and returns focus", async () => {
    const chat = createMockChatApi({ seed: true, chunkDelayMs: 0 });
    await chat("/api/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: { kind: "book", bookId: "a" },
        title: "Book notes",
        messages: [
          { role: "user", content: "About the book" },
          { role: "assistant", content: "Book answer." },
        ],
      }),
    });
    const patches: string[] = [];
    const api: ApiFn = async (path, init) => {
      if (init?.method === "PATCH") patches.push(path);
      return chat(path, init);
    };
    renderTutor(
      api,
      tutorChatStatus({ sessionLimits: { maxSessions: 200, count: 2, maxMessages: 100 } }),
      ["/read/a"],
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reader tutor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));

    expect(await screen.findByRole("heading", { name: "This book", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Whole library", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("2 of 200 sessions saved on this server.")).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "This book sessions" })).getByText(/2 messages/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename session: Book notes" }));
    const input = screen.getByRole("textbox", { name: "Session title" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "Renamed notes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const bookSessions = screen.getByRole("list", { name: "This book sessions" });
      expect(within(bookSessions).getByText("Renamed notes")).toBeInTheDocument();
    });
    expect(patches).toEqual(["/api/chat/conversations/mock-conv-1"]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rename session: Renamed notes" })).toHaveFocus(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename session: Renamed notes" }));
    const again = screen.getByRole("textbox", { name: "Session title" });
    fireEvent.change(again, { target: { value: "Never saved" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(
      within(screen.getByRole("list", { name: "This book sessions" })).getByText("Renamed notes"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Never saved")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rename session: Renamed notes" })).toHaveFocus(),
    );
  });

  it("announces the mode and the library choice, and returns focus to the field", async () => {
    renderTutor(createMockChatApi({ seed: false, chunkDelayMs: 0 }));
    await openDock();

    fireEvent.click(askRadio());
    await waitFor(() => expect(announcement()).toContain("Ask mode. Nothing is saved."));
    await waitFor(() => expect(questionBox()).toHaveFocus());

    fireEvent.click(librarySwitch());
    await waitFor(() =>
      expect(announcement()).toContain(
        "Ask without your library: the model answers on its own, no citations. Your books are not searched or sent.",
      ),
    );

    fireEvent.click(sessionRadio());
    await waitFor(() => expect(announcement()).toContain("Session mode. Saved as a new session."));
    await waitFor(() => expect(questionBox()).toHaveFocus());
  });

  it("keeps the attached excerpt in Ask and warns that it is sent", async () => {
    const bodies: Body[] = [];
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const api: ApiFn = async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    renderTutor(api, tutorChatStatus(), ["/read/a"]);
    fireEvent.click(await screen.findByRole("button", { name: "Reader tutor" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask selection" }));
    fireEvent.click(askRadio());

    expect(screen.getAllByText("Attached text is sent to the model.").length).toBeGreaterThan(0);
    expect(screen.getByText("A selected passage.")).toBeInTheDocument();
    fireEvent.change(questionBox(), { target: { value: "About this passage" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();

    expect(bodies[0]).toMatchObject({
      mode: "ask",
      useLibrary: true,
      scope: { kind: "book", bookId: "a", excerpt: "A selected passage." },
    });
  });
});
