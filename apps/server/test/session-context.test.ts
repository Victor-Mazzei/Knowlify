import { describe, expect, it } from "vitest";
import {
  buildRetrievalQueries,
  dropCannedPairs,
  estimateTokens,
  MAX_QUERY_CHARS,
  NO_PASSAGES_ANSWER,
  stripCitationMarkers,
  type ContextMessage,
} from "../src/domain/assistant/sessionContext.js";

function message(role: ContextMessage["role"], content: string): ContextMessage {
  return { role, content };
}

describe("session context helpers", () => {
  it("estimates tokens as ceil(chars/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4_000))).toBe(1_000);
  });

  it("strips stored citation markers and leaves ordinary brackets alone", () => {
    expect(stripCitationMarkers("Deep work [1] needs focus [12].")).toBe("Deep work needs focus.");
    expect(stripCitationMarkers("[1] Focus.")).toBe("Focus.");
    expect(stripCitationMarkers("An array-like [note] and [x] stay.")).toBe("An array-like [note] and [x] stay.");
    expect(stripCitationMarkers("  [1]  ")).toBe("");
  });

  it("drops only exact legacy canned pairs, including the paired question", () => {
    const history: ContextMessage[] = [
      message("user", "What is deep work?"),
      message("assistant", "Deep work is focus."),
      message("user", "And the rest?"),
      message("assistant", NO_PASSAGES_ANSWER),
      message("user", "Tell me more."),
      message("assistant", "Which part do you want to start with?"),
    ];
    expect(dropCannedPairs(history)).toEqual([
      message("user", "What is deep work?"),
      message("assistant", "Deep work is focus."),
      message("user", "Tell me more."),
      message("assistant", "Which part do you want to start with?"),
    ]);

    const similar = `${NO_PASSAGES_ANSWER} Try another wording.`;
    expect(dropCannedPairs([message("assistant", similar)])).toEqual([message("assistant", similar)]);
  });

  it("anchors a short follow-up on the tutor's last question", () => {
    const history: ContextMessage[] = [
      message("user", "What is deep work?"),
      message("assistant", "Great question. Which part of deep work [1] would you like to practice first?"),
    ];
    expect(buildRetrievalQueries("The focus part.", history)).toEqual([
      "Which part of deep work would you like to practice first? The focus part.",
      "The focus part.",
    ]);
  });

  it("falls back to the last user message when the tutor turn has no question", () => {
    const history: ContextMessage[] = [
      message("user", "What is deep work?"),
      message("assistant", "It is sustained focus without distraction."),
    ];
    expect(buildRetrievalQueries("why?", history)).toEqual(["What is deep work? why?", "why?"]);
  });

  it("searches a long message as written and retries with the anchored form", () => {
    const history: ContextMessage[] = [
      message("user", "What is deep work?"),
      message("assistant", "Which part do you want to discuss next?"),
    ];
    const question = "What does the book say about deliberate practice and how should I plan my week around it?";
    expect(buildRetrievalQueries(question, history)).toEqual([
      question,
      `Which part do you want to discuss next? ${question}`,
    ]);
    expect(buildRetrievalQueries(question, [])).toEqual([question]);
  });

  it("caps the anchor and the query at the documented budgets", () => {
    const history: ContextMessage[] = [
      message("assistant", `${"q".repeat(300)}?`),
      message("user", "Previous"),
    ];
    const [expanded] = buildRetrievalQueries("short", history);
    expect(expanded.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(expanded.startsWith("q".repeat(250))).toBe(true);

    const [capped] = buildRetrievalQueries("x".repeat(MAX_QUERY_CHARS + 100), []);
    expect(capped).toHaveLength(MAX_QUERY_CHARS);
  });

  it("keeps the end of a long follow-up message and searches it as a zero-hit fallback", () => {
    const history: ContextMessage[] = [
      message("assistant", `Which part of ${"deep work ".repeat(23)}would you like to practice first?`),
      message("user", "Previous"),
    ];
    const question = `${"z".repeat(300)} IMPORTANT_TERM`;
    const queries = buildRetrievalQueries(question, history);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe(question);
    expect(queries[1]).toContain("Which part of deep work");
    expect(queries[1].endsWith(question)).toBe(true);
    for (const query of queries) {
      expect(query).toContain("IMPORTANT_TERM");
      expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    }
  });

  it("returns no query for an empty question", () => {
    expect(buildRetrievalQueries("   ", [])).toEqual([]);
  });
});
