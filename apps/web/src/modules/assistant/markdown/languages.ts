/**
 * The only languages the tutor highlights. Keeping the list explicit keeps the
 * lazy highlighter chunk small and predictable.
 */
export type SupportedLanguage =
  | "c"
  | "cpp"
  | "rust"
  | "python"
  | "javascript"
  | "typescript"
  | "go"
  | "java"
  | "bash"
  | "sql"
  | "json"
  | "yaml"
  | "xml"
  | "css"
  | "markdown"
  | "diff";

const ALIASES = new Map<string, SupportedLanguage>([
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["c++", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["rust", "rust"],
  ["rs", "rust"],
  ["python", "python"],
  ["py", "python"],
  ["javascript", "javascript"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["typescript", "typescript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["go", "go"],
  ["golang", "go"],
  ["java", "java"],
  ["bash", "bash"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["sql", "sql"],
  ["json", "json"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["xml", "xml"],
  ["html", "xml"],
  ["htm", "xml"],
  ["svg", "xml"],
  ["css", "css"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["diff", "diff"],
  ["patch", "diff"],
]);

const LABELS = new Map<SupportedLanguage, string>([
  ["c", "C"],
  ["cpp", "C++"],
  ["rust", "Rust"],
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["go", "Go"],
  ["java", "Java"],
  ["bash", "Bash"],
  ["sql", "SQL"],
  ["json", "JSON"],
  ["yaml", "YAML"],
  ["xml", "XML"],
  ["css", "CSS"],
  ["markdown", "Markdown"],
  ["diff", "Diff"],
]);

export function canonicalLanguage(raw: string | null | undefined): SupportedLanguage | null {
  const key = raw?.trim().toLowerCase();
  return key ? ALIASES.get(key) ?? null : null;
}

export function languageLabel(raw: string | null | undefined): string {
  const key = raw?.trim().toLowerCase();
  if (key === "html" || key === "htm") return "HTML";
  if (key === "svg") return "SVG";
  const canonical = canonicalLanguage(key);
  return canonical ? LABELS.get(canonical) ?? "Code" : "Code";
}
