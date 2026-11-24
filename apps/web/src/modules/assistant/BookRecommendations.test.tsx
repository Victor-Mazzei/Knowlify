import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { createMockChatApi } from "./mockChat";
import { ReaderProbe, TutorTestProviders, tutorChatStatus } from "./tutorHarness";
import type { ChatStatus } from "./types";

type Body = Record<string, unknown>;

function renderTutor(
  api: ApiFn,
  status: ChatStatus = tutorChatStatus(),
  initialEntries = ["/"],
) {
  return render(
    <TutorTestProviders api={api} status={status} initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<p>library page</p>} />
        <Route path="/read/:id" element={<ReaderProbe bookId="a" title="Book a" />} />
      </Routes>
    </TutorTestProviders>,
  );
}

const openDock = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Open tutor" }));
};

const askRadio = () => screen.getByRole("radio", { name: "Ask" });
const sessionRadio = () => screen.getByRole("radio", { name: "Session" });
const librarySwitch = () => screen.getByRole("switch", { name: "Search my books" });
const settingsButton = () => screen.queryByRole("button", { name: "Answer settings" });
const bookSwitch = () => screen.queryByRole("switch", { name: "Suggest books from my library" });
const questionBox = () => screen.getByRole("textbox", { name: "Your question" });
const recommendButton = () => screen.queryByRole("button", { name: "Suggest books" });

const captureBodies = (chat: ApiFn) => {
  const bodies: Body[] = [];
  const api: ApiFn = async (path, init) => {
    if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)) as Body);
    }
    return chat(path, init);
  };
  return { api, bodies };
};

beforeEach(() => localStorage.clear());

describe("Book recommendations in Ask", () => {
  it("sends recommend:on once, then the stored preference, and shows the cards after done", async () => {
    const { api, bodies } = captureBodies(createMockChatApi({ seed: false, chunkDelayMs: 0 }));
    renderTutor(api);
    await openDock();
    fireEvent.click(askRadio());

    expect(recommendButton()).toBeInTheDocument();
    expect(settingsButton()).toBeInTheDocument();
    expect(bookSwitch()).not.toBeInTheDocument();
    fireEvent.click(settingsButton()!);
    expect(bookSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Auto")).toBeInTheDocument();
    fireEvent.click(settingsButton()!);

    fireEvent.click(recommendButton()!);
    expect(recommendButton()).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(questionBox(), {
      target: { value: "Which books in my library teach Rust for the web?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("list", { name: "Books from your library" })).toBeInTheDocument();
    expect(bodies[0]).toMatchObject({ mode: "ask", useLibrary: true, recommend: "on" });
    // The one-shot request is disarmed after sending.
    await waitFor(() => expect(recommendButton()).toHaveAttribute("aria-pressed", "false"));

    const cards = screen.getByRole("list", { name: "Books from your library" });
    const titles = within(cards)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(titles).toEqual(["Rust for Web Developers", "Programming Rust"]);
    const first = within(cards).getByRole("link", {
      name: "Open Rust for Web Developers by Mara Klein",
    });
    expect(first).toHaveAttribute("href", "/book/mock-rust-web");
    first.focus();
    expect(first).toHaveFocus();
    expect(within(cards).getByText("Mara Klein")).toBeInTheDocument();
    expect(within(cards).getAllByText("EPUB").length).toBeGreaterThan(0);
    expect(within(cards).getByText("Not read")).toBeInTheDocument();
    expect(within(cards).getByText("In progress 34%")).toBeInTheDocument();
    expect(within(cards).getByText("Matches: rust, web · 2 passages")).toBeInTheDocument();
    expect(screen.getByText("Cards show books from your library.")).toBeInTheDocument();
    // The inline marker becomes a chip with the same accessible name.
    expect(
      screen.getAllByRole("link", { name: "Open Rust for Web Developers by Mara Klein" }).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("[book:1]")).not.toBeInTheDocument();

    fireEvent.change(questionBox(), { target: { value: "A plain follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ recommend: "auto" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument(),
    );

    fireEvent.click(settingsButton()!);
    fireEvent.click(bookSwitch()!);
    expect(bookSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Off")).toBeInTheDocument();
    fireEvent.click(settingsButton()!);
    fireEvent.change(questionBox(), { target: { value: "Which books about Rust?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]).toMatchObject({ recommend: "off" });
    expect(localStorage.getItem("knowlify.tutor.recommend")).toBe("off");
  });

  it("shows no control in Session, in a book, or without the feature", async () => {
    localStorage.setItem("knowlify.tutor.mode", "session");
    const session = captureBodies(createMockChatApi({ seed: false, chunkDelayMs: 0 }));
    const view = renderTutor(session.api);
    await openDock();
    expect(sessionRadio()).toBeChecked();
    expect(recommendButton()).not.toBeInTheDocument();
    expect(settingsButton()).not.toBeInTheDocument();
    view.unmount();

    localStorage.clear();
    const book = captureBodies(createMockChatApi({ seed: false, chunkDelayMs: 0 }));
    const bookView = renderTutor(book.api, tutorChatStatus(), ["/read/a"]);
    fireEvent.click(await screen.findByRole("button", { name: "Reader tutor" }));
    fireEvent.click(askRadio());
    expect(questionBox()).toBeInTheDocument();
    expect(recommendButton()).not.toBeInTheDocument();
    expect(settingsButton()).not.toBeInTheDocument();
    bookView.unmount();

    localStorage.clear();
    const older = captureBodies(
      createMockChatApi({ seed: false, chunkDelayMs: 0, recommendations: false }),
    );
    renderTutor(older.api, tutorChatStatus({ features: undefined }));
    await openDock();
    fireEvent.click(askRadio());
    expect(recommendButton()).not.toBeInTheDocument();
    expect(settingsButton()).not.toBeInTheDocument();
    fireEvent.change(questionBox(), { target: { value: "Which books about Rust?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Spaced repetition works/)).toBeInTheDocument();
    expect(older.bodies[0]).not.toHaveProperty("recommend");
    expect(screen.queryByRole("list", { name: "Books from your library" })).not.toBeInTheDocument();
  });

  it("offers to turn Search my books on instead of hiding suggestions", async () => {
    const { api, bodies } = captureBodies(createMockChatApi({ seed: false, chunkDelayMs: 0 }));
    renderTutor(api);
    await openDock();
    fireEvent.click(askRadio());
    fireEvent.click(librarySwitch());

    expect(recommendButton()).not.toBeInTheDocument();
    expect(screen.getByText("Book suggestions need Search my books.")).toBeInTheDocument();

    fireEvent.change(questionBox(), { target: { value: "Which books about Rust?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Book cards need Search my books/)).toBeInTheDocument();
    expect(bodies[0]).not.toHaveProperty("recommend");
    expect(bodies[0]).toMatchObject({ useLibrary: false });
    await waitFor(() =>
      expect(
        within(screen.getByRole("log")).getByText("Book suggestions need Search my books."),
      ).toBeInTheDocument(),
    );

    const composer = questionBox().closest("form");
    expect(composer).not.toBeNull();
    fireEvent.click(
      within(composer as HTMLElement).getByRole("button", { name: "Turn on Search my books" }),
    );
    expect(librarySwitch()).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Turn on Search my books" }),
      ).not.toBeInTheDocument(),
    );
    // Turning the switch on never resends the question by itself.
    expect(bodies).toHaveLength(1);
  });

  it("shows no cards when the turn fails after the recommendations event", async () => {
    renderTutor(createMockChatApi({ seed: false, chunkDelayMs: 0, scenario: "timeout" }));
    await openDock();
    fireEvent.click(askRadio());
    fireEvent.change(questionBox(), { target: { value: "Recommend books about Rust" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Answer incomplete.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Books from your library" })).not.toBeInTheDocument();
    expect(screen.queryByText("Cards show books from your library.")).not.toBeInTheDocument();
  });

  it("saves the text without cards when the Ask chat becomes a session", async () => {
    const imports: Body[] = [];
    const chat = createMockChatApi({ seed: false, chunkDelayMs: 0 });
    const api: ApiFn = async (path, init) => {
      if (path === "/api/chat/conversations" && init?.method === "POST") {
        imports.push(JSON.parse(String(init.body)) as Body);
      }
      return chat(path, init);
    };
    renderTutor(api);
    await openDock();
    fireEvent.click(askRadio());
    fireEvent.change(questionBox(), { target: { value: "Recommend books about Rust" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("list", { name: "Books from your library" })).toBeInTheDocument();

    fireEvent.click(sessionRadio());
    const dialog = await screen.findByRole("alertdialog", { name: "This Ask chat is not saved." });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save as session" }));

    await waitFor(() => expect(imports).toHaveLength(1));
    const messages = imports[0]?.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toHaveProperty("recommendations");
      expect(message).not.toHaveProperty("recommended");
    }
    expect(messages[1]?.content).toContain("Rust for Web Developers");
  });
});
