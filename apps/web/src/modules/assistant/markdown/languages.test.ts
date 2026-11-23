import { describe, expect, it } from "vitest";
import { canonicalLanguage, languageLabel } from "./languages";

const HOSTILE_NAMES = [
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "__defineGetter__",
  "prototype",
];

describe("language lookup", () => {
  it("does not resolve inherited object properties", () => {
    for (const name of HOSTILE_NAMES) {
      expect(canonicalLanguage(name)).toBeNull();
      expect(languageLabel(name)).toBe("Code");
    }
  });

  it("resolves known aliases and labels", () => {
    expect(canonicalLanguage("c++")).toBe("cpp");
    expect(languageLabel("c++")).toBe("C++");
    expect(canonicalLanguage("js")).toBe("javascript");
    expect(languageLabel("js")).toBe("JavaScript");
    expect(canonicalLanguage("html")).toBe("xml");
    expect(languageLabel("html")).toBe("HTML");
    expect(canonicalLanguage("xml")).toBe("xml");
    expect(languageLabel("xml")).toBe("XML");
    expect(languageLabel("kotlin")).toBe("Code");
  });
});
