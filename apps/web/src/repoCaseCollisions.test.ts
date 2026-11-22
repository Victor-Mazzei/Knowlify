import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * A case-insensitive filesystem (macOS, Windows) cannot hold two paths that
 * differ only by case, and it cannot hold a file and a directory with the same
 * folded name side by side. Git still checks both out, so TypeScript and the
 * bundler silently resolve whichever copy the filesystem returns first.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const repoRoot = git(process.cwd(), "rev-parse", "--show-toplevel").trim();
const trackedFiles = git(repoRoot, "ls-files", "-z").split("\0").filter((file) => file !== "");

type PathKind = "directory" | "file";

type TrackedPath = {
  readonly kind: PathKind;
  readonly path: string;
};

const directoryPrefixes = (file: string): string[] => {
  const segments = file.split("/");
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
};

/**
 * Tracked files plus every directory their paths imply, deduplicated by exact
 * path so a directory shared by several files counts once.
 */
const expandTrackedPaths = (files: readonly string[]): TrackedPath[] => {
  const paths = new Map<string, TrackedPath>();
  for (const file of files) {
    paths.set(file, { kind: "file", path: file });
    for (const directory of directoryPrefixes(file)) {
      if (!paths.has(directory)) paths.set(directory, { kind: "directory", path: directory });
    }
  }
  return [...paths.values()];
};

type FoldedPath = {
  readonly key: string;
  readonly label: string;
};

const duplicateReports = (entries: readonly FoldedPath[]): string[] => {
  const byKey = new Map<string, string[]>();
  for (const { key, label } of entries) {
    const labels = byKey.get(key);
    if (labels) labels.push(label);
    else byKey.set(key, [label]);
  }
  return [...byKey.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([key, labels]) => `${key}: ${labels.join(", ")}`)
    .sort();
};

const caseCollisions = (files: readonly string[]): string[] =>
  duplicateReports(
    expandTrackedPaths(files).map(({ kind, path }) => ({
      key: path.toLowerCase(),
      label: `${path} (${kind})`,
    })),
  );

const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Extensions keep LlmForm.tsx and llmForm.ts apart on a case-insensitive
 * filesystem, but "./LlmForm" can resolve to either one: the stems collide.
 */
const scriptStemKey = (file: string): string => {
  const separator = file.lastIndexOf("/");
  const base = file.slice(separator + 1);
  const extension = base.lastIndexOf(".");
  const stem = extension > 0 ? base.slice(0, extension) : base;
  return `${file.slice(0, separator + 1)}${stem.toLowerCase()}`;
};

const siblingScriptCollisions = (files: readonly string[]): string[] =>
  duplicateReports(
    files
      .filter((file) => SCRIPT_FILE.test(file))
      .map((file) => ({ key: scriptStemKey(file), label: file })),
  );

describe("case-collision detector", () => {
  it("reports two files whose paths differ only by case", () => {
    expect(caseCollisions(["src/Foo/a.ts", "src/foo/A.ts"])).not.toEqual([]);
  });

  it("reports sibling directories that differ only by case", () => {
    expect(caseCollisions(["src/Foo/a.ts", "src/foo/b.ts"])).not.toEqual([]);
  });

  it("reports a file that matches a directory of another case", () => {
    expect(caseCollisions(["src/Foo", "src/foo/b.ts"])).not.toEqual([]);
  });

  it("reports a directory that matches a file of another case", () => {
    expect(caseCollisions(["src/Foo/a.ts", "src/foo"])).not.toEqual([]);
  });

  it("accepts a directory shared by several files", () => {
    expect(caseCollisions(["src/Foo/a.ts", "src/Foo/b.ts", "src/Foo/nested/c.ts"])).toEqual([]);
  });

  it("accepts equal names under different parents", () => {
    expect(caseCollisions(["src/Foo/a.ts", "ui/Foo/b.ts", "ui/Bar/a.ts"])).toEqual([]);
  });
});

describe("script-stem detector", () => {
  it("reports sibling scripts whose stems differ only by case", () => {
    expect(siblingScriptCollisions(["src/form/LlmForm.tsx", "src/form/llmForm.ts"])).not.toEqual([]);
  });

  it("accepts scripts with distinct stems", () => {
    expect(siblingScriptCollisions(["src/form/LlmForm.tsx", "src/form/llmFormModel.ts"])).toEqual(
      [],
    );
  });

  it("accepts equal stems under different directories", () => {
    expect(siblingScriptCollisions(["src/form/LlmForm.tsx", "src/card/llmForm.ts"])).toEqual([]);
  });

  it("ignores files that are not scripts", () => {
    expect(siblingScriptCollisions(["docs/readme.md", "docs/README.md"])).toEqual([]);
  });
});

describe("tracked paths", () => {
  it("never differ only by case, including directories and files", () => {
    expect(caseCollisions(trackedFiles)).toEqual([]);
  });

  it("never expose sibling scripts whose names differ only by case", () => {
    expect(siblingScriptCollisions(trackedFiles)).toEqual([]);
  });
});
