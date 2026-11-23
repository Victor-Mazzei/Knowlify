import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SaveAskDialog } from "./SaveAskDialog";

const base = {
  scopeLabel: "this book",
  questionCount: 2,
  canSave: true,
  saving: false,
  error: "",
  onSave: () => undefined,
  onDiscard: () => undefined,
  onCancel: () => undefined,
};

describe("SaveAskDialog", () => {
  it("warns that the Ask chat is not saved and offers the three actions", () => {
    render(<SaveAskDialog {...base} />);
    const dialog = screen.getByRole("alertdialog", { name: "This Ask chat is not saved." });
    expect(dialog).toHaveTextContent("These 2 questions are not saved.");
    expect(dialog).toHaveTextContent("this book");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as session" })).toBeEnabled();
  });

  it("uses singular wording for one question", () => {
    render(<SaveAskDialog {...base} questionCount={1} canSave={false} />);
    expect(
      screen.getByText("This question is not saved. Keep it as a session about this book, or discard it."),
    ).toBeInTheDocument();
  });

  it("disables Save while there is no answer to import", () => {
    render(<SaveAskDialog {...base} canSave={false} />);
    expect(screen.getByRole("button", { name: "Save as session" })).toBeDisabled();
    expect(screen.getByText("Ask a question and get an answer before saving this chat.")).toBeInTheDocument();
  });

  it("keeps the dialog open with the server error", () => {
    render(<SaveAskDialog {...base} error="You reached the session limit." />);
    expect(screen.getByRole("alert")).toHaveTextContent("You reached the session limit.");
    expect(screen.getByRole("button", { name: "Save as session" })).toBeInTheDocument();
  });

  it("blocks Save, explains the limit and offers an explicit last-20 action", () => {
    const onSaveLast = vi.fn();
    render(
      <SaveAskDialog
        {...base}
        questionCount={11}
        messageCount={22}
        overLimit
        lastMessageCount={20}
        droppedMessages={2}
        canSave={false}
        onSaveLast={onSaveLast}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This chat has 22 messages. A session can hold at most 20, so Save as session is not available.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("nothing was saved");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You can save the newest 20 messages instead; the 2 oldest messages will not be saved.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Cancel keeps this chat. Discard deletes it.");
    expect(screen.getByText(/not saved, and this chat cannot be saved as one session/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
    expect(
      screen.queryByText("Ask a question and get an answer before saving this chat."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save last 20 messages" }));
    expect(onSaveLast).toHaveBeenCalledTimes(1);
  });

  it("explains an oversized message with the character limit", () => {
    render(<SaveAskDialog {...base} oversized="answer" canSave={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "An answer in this chat is longer than 8,000 characters.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This chat cannot be saved as a session.");
    expect(screen.getByRole("button", { name: "Save as session" })).toBeDisabled();
  });

  it("explains a transcript that is not a question-and-answer sequence", () => {
    render(<SaveAskDialog {...base} malformed canSave={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This chat is not a question-and-answer sequence, so it cannot be saved as a session.",
    );
    expect(screen.getByRole("button", { name: "Save as session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("warns about partial answers and an unanswered last question", () => {
    render(
      <SaveAskDialog
        {...base}
        incompleteAnswers={1}
        unansweredQuestions={1}
      />,
    );

    expect(
      screen.getByText("The session will include 1 partial answer exactly as it appears."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The last question has no answer yet. It will not be included."),
    ).toBeInTheDocument();
  });

  it("locks every action while saving", () => {
    render(<SaveAskDialog {...base} saving />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<SaveAskDialog {...base} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
