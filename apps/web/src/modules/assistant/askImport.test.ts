import { describe, expect, it } from "vitest";
import { MAX_IMPORTED_MESSAGES, planAskImport } from "./askImport";
import type { ChatMessage } from "./types";

const message = (index: number, content = `message ${index}`): ChatMessage => ({
  id: `m-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content,
  citations: null,
  createdAt: index,
});

const transcript = (turns: number) =>
  Array.from({ length: turns * 2 }, (_, index) => message(index));

describe("planAskImport", () => {
  it("imports every message when the transcript is exactly at the 20-message limit", () => {
    const plan = planAskImport(transcript(10));

    expect(plan.transcriptMessages).toBe(MAX_IMPORTED_MESSAGES);
    expect(plan.messages).toHaveLength(MAX_IMPORTED_MESSAGES);
    expect(plan.overLimit).toBe(false);
    expect(plan.canSave).toBe(true);
    expect(plan.messages[0]).toMatchObject({ role: "user", content: "message 0" });
    expect(plan.messages[19]).toMatchObject({ role: "assistant", content: "message 19" });
    expect(plan.lastMessages).toHaveLength(20);
    expect(plan.droppedMessages).toBe(0);
  });

  it("blocks a transcript longer than the limit instead of returning only the newest turns", () => {
    const plan = planAskImport(transcript(11));

    expect(plan.transcriptMessages).toBe(22);
    expect(plan.overLimit).toBe(true);
    expect(plan.canSave).toBe(false);
    expect(plan.messages).toHaveLength(22);
    expect(plan.messages[0]).toMatchObject({ role: "user", content: "message 0" });
    expect(plan.lastMessages).toHaveLength(20);
    expect(plan.lastMessages[0]).toMatchObject({ role: "user", content: "message 2" });
    expect(plan.lastMessages[19]).toMatchObject({ role: "assistant", content: "message 21" });
    expect(plan.droppedMessages).toBe(2);
  });

  it("blocks at 21 messages, including an answered transcript plus an unanswered question", () => {
    const plan = planAskImport([...transcript(10), message(20)]);

    expect(plan.transcriptMessages).toBe(21);
    expect(plan.unansweredQuestions).toBe(1);
    expect(plan.overLimit).toBe(true);
    expect(plan.canSave).toBe(false);
    expect(plan.lastMessages).toHaveLength(20);
    expect(plan.droppedMessages).toBe(0);
  });

  it("keeps partial answers and reports them without losing them", () => {
    const messages = [
      message(0, "A question"),
      { ...message(1, "A partial answer"), incomplete: true },
      message(2, "Another question"),
      message(3, "A full answer"),
    ];
    const plan = planAskImport(messages);

    expect(plan.incompleteAnswers).toBe(1);
    expect(plan.canSave).toBe(true);
    expect(plan.messages).toEqual([
      { role: "user", content: "A question" },
      { role: "assistant", content: "A partial answer" },
      { role: "user", content: "Another question" },
      { role: "assistant", content: "A full answer" },
    ]);
  });

  it("omits an unanswered trailing question but tells the caller", () => {
    const plan = planAskImport([message(0, "Answered"), message(1, "An answer"), message(2, "No answer yet")]);

    expect(plan.transcriptMessages).toBe(3);
    expect(plan.unansweredQuestions).toBe(1);
    expect(plan.messages).toEqual([
      { role: "user", content: "Answered" },
      { role: "assistant", content: "An answer" },
    ]);
    expect(plan.canSave).toBe(true);
  });

  it("blocks a message larger than the import route accepts", () => {
    const plan = planAskImport([
      message(0, "A question"),
      message(1, "x".repeat(8_001)),
    ]);

    expect(plan.oversized).toBe("answer");
    expect(plan.canSave).toBe(false);
  });

  it("blocks a transcript that is not a question/answer sequence", () => {
    const plan = planAskImport([message(0, "A question"), message(2, "A second question"), message(1, "An answer")]);

    expect(plan.malformed).toBe(true);
    expect(plan.canSave).toBe(false);
    expect(plan.messages).toEqual([]);
  });

  it("ignores empty placeholders and keeps citations", () => {
    const citation = {
      n: 1,
      passageId: 4,
      bookId: "book-1",
      bookTitle: "Book one",
      page: 3,
      section: null,
    };
    const plan = planAskImport([
      message(0, "A question"),
      { ...message(1, "An answer"), citations: [citation] },
      message(2, "   "),
    ]);

    expect(plan.transcriptMessages).toBe(2);
    expect(plan.canSave).toBe(true);
    expect(plan.messages[1]).toEqual({ role: "assistant", content: "An answer", citations: [citation] });
  });
});
