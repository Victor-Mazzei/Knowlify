import { describe, expect, it } from "vitest";
import { highlightCode } from "./highlight";

describe("highlightCode", () => {
  it("returns text tokens with hljs classes", () => {
    const tokens = highlightCode("int main() { return 0; }", "cpp");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.some((token) => token.text === "return" && token.className.includes("hljs-keyword"))).toBe(
      true,
    );
    expect(tokens.map((token) => token.text).join("")).toBe("int main() { return 0; }");
  });

  it("highlights Rust and keeps whitespace tokens readable", () => {
    const tokens = highlightCode("fn main() {}", "rust");
    expect(tokens.some((token) => token.text === "fn" && token.className.includes("hljs-keyword"))).toBe(true);
    expect(tokens.map((token) => token.text).join("")).toBe("fn main() {}");
  });
});
