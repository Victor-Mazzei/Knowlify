import { describe, expect, it } from "vitest";
import { newsQueryFromQuote, newsQueryFromTitle } from "./query";

describe("newsQueryFromTitle", () => {
  it("keeps the main title before a subtitle", () => {
    expect(newsQueryFromTitle("Deep Learning Crash Course - A Hands-On, Project-Based Introduction to Artificial Intelligence")).toBe("Deep Learning Crash Course");
    expect(newsQueryFromTitle("Fuzzing Android: A Hands-On Guide")).toBe("Fuzzing Android");
  });
  it("leaves short titles alone and never exceeds the server limit", () => {
    expect(newsQueryFromTitle("Dom Casmurro")).toBe("Dom Casmurro");
    const long = "palavra ".repeat(60);
    expect(newsQueryFromTitle(long).length).toBeLessThanOrEqual(100);
  });
  it("does not collapse a title that only has a leading separator", () => {
    expect(newsQueryFromTitle("- x").length).toBeGreaterThan(0);
  });
});

describe("newsQueryFromQuote", () => {
  it("keeps short quotes as they are", () => {
    expect(newsQueryFromQuote("gradient descent")).toBe("gradient descent");
  });
  it("cuts a long paragraph at a word boundary within the limit", () => {
    const quote = "uma citação muito longa ".repeat(40);
    const result = newsQueryFromQuote(quote);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith(" ")).toBe(false);
    expect(quote.replace(/\s+/g, " ").startsWith(result)).toBe(true);
  });
  it("collapses whitespace and line breaks", () => {
    expect(newsQueryFromQuote("  a\n\n b\t c  ")).toBe("a b c");
  });
});
