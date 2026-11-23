import { describe, expect, it } from "vitest";
import { normalizeStreamingMarkdown } from "./streaming";

describe("normalizeStreamingMarkdown", () => {
  it("leaves a complete answer untouched", () => {
    const text = "**Bold** and *italic* with `code`.";
    expect(normalizeStreamingMarkdown(text, false)).toEqual({
      text,
      unclosedCodeBlock: false,
      unclosedCodeText: null,
      unclosedCodeLanguage: null,
    });
  });

  it("closes an open bold run for display", () => {
    expect(normalizeStreamingMarkdown("2. **Escrita não é atômica", true).text).toBe(
      "2. **Escrita não é atômica**",
    );
  });

  it("closes nested emphasis in reverse order", () => {
    expect(normalizeStreamingMarkdown("**bold *italic", true).text).toBe("**bold *italic***");
  });

  it("keeps a list bullet literal", () => {
    expect(normalizeStreamingMarkdown("* item\n* another", true).text).toBe("* item\n* another");
  });

  it("does not turn a glob into emphasis", () => {
    expect(normalizeStreamingMarkdown("Use *.ts files", true).text).toBe("Use *.ts files");
  });

  it("closes an open inline code span", () => {
    expect(normalizeStreamingMarkdown("Run `npm test", true).text).toBe("Run `npm test`");
  });

  it("closes an open fenced block and reports its language and content", () => {
    const result = normalizeStreamingMarkdown("Before\n\n```cpp\nint main() {\n  return 0;\n", true);
    expect(result.unclosedCodeBlock).toBe(true);
    expect(result.unclosedCodeLanguage).toBe("cpp");
    expect(result.unclosedCodeText).toBe("int main() {\n  return 0;");
    expect(result.text.endsWith("```")).toBe(true);
    expect(result.text).toContain("int main() {");
  });

  it("does not treat a closed fence as open", () => {
    const result = normalizeStreamingMarkdown("```rust\nfn main() {}\n```\nAfter", true);
    expect(result.unclosedCodeBlock).toBe(false);
    expect(result.text).toBe("```rust\nfn main() {}\n```\nAfter");
  });

  it("ignores markers inside a closed fenced block", () => {
    const result = normalizeStreamingMarkdown("```\n**not bold\n```\ntext **bold", true);
    expect(result.text).toBe("```\n**not bold\n```\ntext **bold**");
  });

  it("keeps an unclosed fence in a complete answer open for the renderer", () => {
    const source = "```python\nprint('x')";
    const result = normalizeStreamingMarkdown(source, false);
    expect(result.unclosedCodeBlock).toBe(true);
    expect(result.unclosedCodeText).toBe("print('x')");
    expect(result.text).toBe(source);
  });

  it("inserts closers before trailing whitespace", () => {
    expect(normalizeStreamingMarkdown("**bold\n\n", true).text).toBe("**bold**\n\n");
  });

  it("adds a placeholder delimiter to a standalone table header", () => {
    expect(normalizeStreamingMarkdown("| A | B |", true).text).toBe(
      "| A | B |\n| --- | --- |",
    );
    expect(normalizeStreamingMarkdown("| A | B |\n", true).text).toBe(
      "| A | B |\n| --- | --- |\n",
    );
  });

  it("does not add a delimiter once the real one arrives", () => {
    expect(normalizeStreamingMarkdown("| A | B |\n| --- | --- |", true).text).toBe(
      "| A | B |\n| --- | --- |",
    );
  });

  it("does not treat a prose line with one pipe as a table", () => {
    expect(normalizeStreamingMarkdown("| A |", true).text).toBe("| A |");
  });

  it("does not add a delimiter after a closed fenced block", () => {
    const source = "```\n| A | B |\n```";
    expect(normalizeStreamingMarkdown(source, true).text).toBe(source);
  });

  it("does not close an emphasis marker that has no text yet", () => {
    expect(normalizeStreamingMarkdown("**", true).text).toBe("**");
  });
});
