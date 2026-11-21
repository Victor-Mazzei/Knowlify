import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderBody } from "./ReaderBody";
import type { ApiFn } from "../../components/dialogs";
import {
  TutorTestProviders,
  chatStatusContext,
  eventResponse,
  tutorChatStatus,
} from "../assistant/tutorHarness";

const mocks = vi.hoisted(() => ({
  setPage: vi.fn(),
  stepEpub: vi.fn(),
  goToPage: vi.fn(),
  scheduleProgress: vi.fn(),
  flushProgress: vi.fn(),
  onSelection: undefined as ((selection: { location: string; text: string }) => void) | undefined,
  epubReady: false,
  epubPage: { page: 0, total: 0 },
  percentage: 0,
  pdfVisibleText: "",
  section: "",
}));

vi.mock("./usePdfReader", () => ({
  usePdfReader: () => ({ page: 3, setPage: mocks.setPage, numPages: 10, visibleText: () => mocks.pdfVisibleText }),
}));
vi.mock("./useEpubReader", () => ({
  useEpubReader: (options: { onSelection: (selection: { location: string; text: string }) => void }) => {
    mocks.onSelection = options.onSelection;
    return {
      epubReady: mocks.epubReady,
      epubPage: mocks.epubPage,
      goToPage: mocks.goToPage,
      step: mocks.stepEpub,
      currentCfi: () => "",
      displayLocation: () => true,
      visibleText: () => "",
      currentSection: () => mocks.section,
    };
  },
}));
vi.mock("./useReadingProgress", () => ({
  useReadingProgress: () => ({
    scheduleProgress: mocks.scheduleProgress,
    flushProgress: mocks.flushProgress,
    latestProgress: { current: { position: "", percentage: 0 } },
    percentage: mocks.percentage,
  }),
}));

const book = {
  id: "b1", title: "A Book", author: "An Author", format: "pdf" as const, size: 10,
  addedAt: 0, hasCover: false, status: "ready" as const, source: false,
};

const answer = (conversationId = "c1") => [
  { type: "sources", conversationId, retrieval: "hybrid", citations: [] },
  { type: "delta", text: "An answer." },
  { type: "done", conversationId, messageId: "m1", title: "Question", finishReason: "stop" },
];

const baseApi = (bodies: unknown[] = []): ApiFn => async (path, init) => {
  if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
    bodies.push(JSON.parse(String(init.body)));
    return eventResponse(answer());
  }
  if (path.endsWith("/api/chat/status")) {
    return new Response(JSON.stringify(tutorChatStatus()));
  }
  return new Response(JSON.stringify([]));
};

function renderBody(api: ApiFn, status = tutorChatStatus()) {
  render(
    <TutorTestProviders api={api} status={status} initialEntries={["/read/b1"]}>
      <ReaderBody book={book} data={new ArrayBuffer(0)} progress={{ position: "", percentage: 0 }} jump="" api={api} />
    </TutorTestProviders>,
  );
}

describe("ReaderBody", () => {
  beforeEach(() => {
    mocks.epubReady = false;
    mocks.epubPage = { page: 0, total: 0 };
    mocks.percentage = 0;
    mocks.pdfVisibleText = "";
    mocks.section = "";
    mocks.goToPage.mockClear();
  });

  it("shows the book toolbar and opens the notes panel", async () => {
    renderBody(baseApi());

    expect(screen.getByText("A Book")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Current page" })).toHaveValue("3");
    expect(screen.getByText("/ 10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Notes" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "New note" })).toBeInTheDocument();
  });

  it("uses the shared chat status without probing the API again", () => {
    const api = vi.fn(baseApi());
    renderBody(api);

    expect(screen.getByRole("button", { name: "Tutor" })).toBeInTheDocument();
    expect(api.mock.calls.filter(([path]) => String(path).endsWith("/api/chat/status"))).toHaveLength(0);
  });

  it("shows no tutor entry when chat is disabled", () => {
    renderBody(baseApi(), tutorChatStatus({ enabled: false, model: null, host: null }));
    expect(screen.queryByRole("button", { name: "Tutor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tutor/i })).not.toBeInTheDocument();
  });

  it("shows the live remaining progress from the reading hook", () => {
    mocks.percentage = 0.42;
    renderBody(baseApi());
    expect(screen.getByText("58% left")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute("aria-valuenow", "42");
  });

  it("opens the tutor from the toolbar, focuses the composer and closes with Escape", async () => {
    renderBody(baseApi());
    const opener = screen.getByRole("button", { name: "Tutor" });
    opener.focus();
    fireEvent.click(opener);

    expect(await screen.findByRole("complementary", { name: "Tutor" })).toBeInTheDocument();
    const textbox = await screen.findByRole("textbox", { name: "Your question" });
    await waitFor(() => expect(textbox).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Tutor" })).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
  });

  it("offers Ask about this and sends the selection with page and section", async () => {
    const bodies: unknown[] = [];
    mocks.epubReady = true;
    mocks.epubPage = { page: 4, total: 40 };
    mocks.section = "Chapter 3";
    const epub = { ...book, format: "epub" as const };
    render(
      <TutorTestProviders api={baseApi(bodies)} status={tutorChatStatus()} initialEntries={["/read/b1"]}>
        <ReaderBody book={epub} data={new ArrayBuffer(0)} progress={{ position: "", percentage: 0 }} jump="" api={baseApi(bodies)} />
      </TutorTestProviders>,
    );
    await screen.findByRole("button", { name: "Tutor" });

    act(() => mocks.onSelection?.({ location: "epubcfi(/6/4!/4/2)", text: "A selected passage." }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));

    expect(await screen.findByText("Selected text")).toBeInTheDocument();
    expect(screen.getByText("A selected passage.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Explain this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("An answer.")).toBeInTheDocument();
    expect(bodies[0]).toMatchObject({
      message: "Explain this.",
      scope: {
        kind: "book",
        bookId: "b1",
        excerpt: "A selected passage.",
        excerptKind: "selection",
        page: 4,
        section: "Chapter 3",
      },
    });
  });

  it("can attach the visible page text instead", async () => {
    const bodies: unknown[] = [];
    mocks.pdfVisibleText = "The page on screen.";
    renderBody(baseApi(bodies));

    fireEvent.click(await screen.findByRole("button", { name: "Tutor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use page text" }));
    expect(screen.getByText("Page text")).toBeInTheDocument();
    expect(screen.getByText("The page on screen.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "What is this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      scope: { excerpt: "The page on screen.", excerptKind: "visible", page: 3 },
    });
  });

  it("explains when the page text is not available", async () => {
    renderBody(baseApi());
    fireEvent.click(await screen.findByRole("button", { name: "Tutor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use page text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No page text is available here.");
  });

  it("closes the tutor when the notes panel opens", async () => {
    renderBody(baseApi());
    fireEvent.click(await screen.findByRole("button", { name: "Tutor" }));
    expect(await screen.findByRole("complementary", { name: "Tutor" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Tutor" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("complementary", { name: "Notes" })).toBeInTheDocument();
  });

  it("closes the notes panel when the tutor opens by shortcut", async () => {
    renderBody(baseApi());
    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    expect(await screen.findByRole("complementary", { name: "Notes" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "T", code: "KeyT", altKey: true });
    expect(await screen.findByRole("complementary", { name: "Tutor" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Notes" })).not.toBeInTheDocument();
  });

  it("jumps to an estimated EPUB page from a citation link", async () => {
    mocks.epubReady = true;
    mocks.epubPage = { page: 1, total: 40 };
    const epub = { ...book, format: "epub" as const };
    render(
      <TutorTestProviders api={baseApi()} status={tutorChatStatus()} initialEntries={["/read/b1"]}>
        <ReaderBody book={epub} data={new ArrayBuffer(0)} progress={{ position: "", percentage: 0 }} jump="12" api={baseApi()} />
      </TutorTestProviders>,
    );

    await waitFor(() => expect(mocks.goToPage).toHaveBeenCalledWith(12));
  });
});
