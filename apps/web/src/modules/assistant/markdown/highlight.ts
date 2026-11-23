/**
 * Lazy syntax highlighter. This module is imported with `import()` only after a
 * fenced block closes, so the initial bundle never pays for highlight.js.
 *
 * Lowlight returns a hast tree; it is flattened to plain text/class tokens and
 * rendered as React spans. No HTML string is ever injected into the document.
 */
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { SupportedLanguage } from "./languages";

const lowlight = createLowlight({
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
});

export type HighlightToken = { text: string; className: string };

const HLJS_CLASS = /^hljs-[a-z0-9-]+$/;

type HastNode = {
  type?: unknown;
  value?: unknown;
  properties?: unknown;
  children?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function classNames(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter((item) => HLJS_CLASS.test(item));
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && HLJS_CLASS.test(item));
  return [];
}

function walk(node: HastNode, classes: string[], tokens: HighlightToken[]) {
  if (node.type === "text" && typeof node.value === "string") {
    const className = classes.join(" ");
    const last = tokens[tokens.length - 1];
    if (last && last.className === className) last.text += node.value;
    else tokens.push({ text: node.value, className });
    return;
  }

  if (node.type === "root" && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (isRecord(child)) walk(child as HastNode, classes, tokens);
    }
    return;
  }

  if (node.type !== "element") return;
  const properties = isRecord(node.properties) ? node.properties : {};
  const nested = [...classes, ...classNames(properties.className)];
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (isRecord(child)) walk(child as HastNode, nested, tokens);
  }
}

export function highlightCode(code: string, language: SupportedLanguage): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const tree = lowlight.highlight(language, code);
  walk(tree as unknown as HastNode, [], tokens);
  return tokens;
}
