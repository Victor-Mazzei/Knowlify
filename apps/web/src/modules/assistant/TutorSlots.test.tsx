import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { createMockChatApi } from "./mockChat";
import {
  ReaderProbe,
  TutorTestProviders,
  controlledStream,
  eventResponse,
  tutorChatStatus,
} from "./tutorHarness";

const answerEvents = (conversationId: string, text = "An answer.") => [
  { type: "sources", conversationId, retrieval: "hybrid", citations: [] },
  { type: "delta", text },
  { type: "done", conversationId, messageId: "m1", title: "Question", finishReason: "stop" },
];

function BookReader() {
  const [id, setId] = useState("a");
  return (
    <>
      {["a", "b", "c", "d"].map((book) => (
        <button key={book} type="button" onClick={() => setId(book)}>
          Book {book}
        </button>
      ))}
      <ReaderProbe bookId={id} title={`Book ${id}`} page={4} section="Chapter 1" />
    </>
  );
}

function renderReader(api: ApiFn, status = tutorChatStatus()) {
  render(
    <TutorTestProviders api={api} status={status} initialEntries={["/read/a"]}>
      <Routes>
        <Route path="/read/:id" element={<BookReader />} />
      </Routes>
    </TutorTestProviders>,
  );
}

const readerTutor = () => screen.getByRole("button", { name: "Reader tutor" });

describe("Tutor slots", () => {
  it("keeps independent book and library conversations and never crosses scopes", async () => {
    const bodies: unknown[] = [];
    const chat = createMockChatApi({ seed: false });
    const api: ApiFn = async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { scope: { kind: string } };
        bodies.push(body);
        return eventResponse(answerEvents(`c${bodies.length}`, `Answer ${bodies.length}`));
      }
      return chat(path, init);
    };
    renderReader(api);

    expect(await screen.findByRole("button", { name: "Reader tutor" })).toBeInTheDocument();
    fireEvent.click(readerTutor());
    expect(await screen.findByRole("complementary", { name: "Tutor" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Book a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "This book" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "About A" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Answer 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Whole library" }));
    expect(await screen.findByRole("heading", { name: "Whole library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Whole library" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "About library" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Answer 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "This book" }));
    expect(await screen.findByText("About A")).toBeInTheDocument();
    expect(screen.getByText("Answer 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Whole library" }));
    expect(await screen.findByText("About library")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    expect(bodies.map((body) => (body as { scope: unknown }).scope)).toEqual([
      { kind: "book", bookId: "a" },
      { kind: "library" },
    ]);
  });

  it("opens each book in its own slot and caps book memory at three", async () => {
    let answer = 0;
    const chat = createMockChatApi({ seed: false });
    const api: ApiFn = async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
        answer += 1;
        return eventResponse(answerEvents(`c${answer}`, `Answer ${answer}`));
      }
      return chat(path, init);
    };
    renderReader(api);
    await screen.findByRole("button", { name: "Reader tutor" });
    fireEvent.click(readerTutor());
    await screen.findByRole("complementary", { name: "Tutor" });

    for (const book of ["a", "b", "c", "d"]) {
      if (book !== "a") {
        fireEvent.click(screen.getByRole("button", { name: `Book ${book}` }));
        fireEvent.click(readerTutor());
      }
      expect(await screen.findByRole("heading", { name: `Book ${book}` })).toBeInTheDocument();
      fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
        target: { value: `Question ${book}` },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByText(`Answer ${book === "a" ? 1 : book === "b" ? 2 : book === "c" ? 3 : 4}`);
    }

    expect(document.querySelectorAll('[data-tutor-slot^="book:"]').length).toBe(3);
    expect(document.querySelector('[data-tutor-slot="book:a"]')).toBeNull();
    expect(document.querySelector('[data-tutor-slot="book:d"]')).not.toBeNull();
  });

  it("never evicts a slot that is still streaming", async () => {
    const stream = controlledStream();
    const chat = createMockChatApi({ seed: false });
    let calls = 0;
    const api: ApiFn = async (path, init) => {
      if (path.endsWith("/api/chat/messages") && init?.method === "POST") {
        calls += 1;
        if (calls === 1) return stream.response(init.signal);
        return eventResponse(answerEvents(`c${calls}`, `Answer ${calls}`));
      }
      return chat(path, init);
    };
    renderReader(api);
    await screen.findByRole("button", { name: "Reader tutor" });
    fireEvent.click(readerTutor());

    fireEvent.change(await screen.findByRole("textbox", { name: "Your question" }), {
      target: { value: "Slow question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    for (const book of ["b", "c", "d"]) {
      fireEvent.click(screen.getByRole("button", { name: `Book ${book}` }));
      fireEvent.click(readerTutor());
      expect(await screen.findByRole("heading", { name: `Book ${book}` })).toBeInTheDocument();
      fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
        target: { value: `Question ${book}` },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByText(`Answer ${book === "b" ? 2 : book === "c" ? 3 : 4}`);
    }

    expect(document.querySelector('[data-tutor-slot="book:a"]')).not.toBeNull();
    expect(document.querySelector('[data-tutor-slot="book:b"]')).toBeNull();
    expect(document.querySelectorAll('[data-tutor-slot^="book:"]').length).toBe(3);

    await act(async () => {
      stream.emit({ type: "delta", text: " Finished." });
      stream.emit({ type: "done", conversationId: "c1", messageId: "m1", title: "Slow question", finishReason: "stop" });
      stream.close();
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument());
  });

  it("disables Whole library when the index is off but keeps this book available", async () => {
    renderReader(
      createMockChatApi({ seed: false }),
      tutorChatStatus({ scopes: { library: false, book: true } }),
    );
    await screen.findByRole("button", { name: "Reader tutor" });
    fireEvent.click(readerTutor());

    expect(await screen.findByRole("button", { name: "This book" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Whole library" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Whole library" })).toHaveAttribute(
      "title",
      "Turn on the search index in Settings to ask across your library.",
    );
  });

  it("shows no floating entry outside the reader when the library scope is off", async () => {
    render(
      <TutorTestProviders
        api={createMockChatApi({ seed: false })}
        status={tutorChatStatus({ scopes: { library: false, book: true } })}
        initialEntries={["/"]}
      >
        <Routes>
          <Route path="/" element={<p>library page</p>} />
        </Routes>
      </TutorTestProviders>,
    );
    expect(await screen.findByText("library page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open tutor" })).not.toBeInTheDocument();
  });
});
