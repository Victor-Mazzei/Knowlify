#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Build metadata is intentionally unsupported: the version is also used as a
// Docker tag, where "+" is not allowed.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

const VERSION_FORMAT_HINT = "expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease";

const PACKAGE_JSON_TARGETS = [
  { id: "root-package", file: "package.json" },
  { id: "server-package", file: "apps/server/package.json" },
  { id: "web-package", file: "apps/web/package.json" },
  { id: "desktop-package", file: "apps/desktop/package.json" },
  { id: "tauri-config", file: "apps/desktop/src-tauri/tauri.conf.json" },
];

const LOCK_FILE = "package-lock.json";
const LOCK_BLOCKS = [
  { id: "lock-root", key: "" },
  { id: "lock-server", key: "apps/server" },
  { id: "lock-web", key: "apps/web" },
  { id: "lock-desktop", key: "apps/desktop" },
];

const CARGO_TOML_FILE = "apps/desktop/src-tauri/Cargo.toml";
const CARGO_LOCK_FILE = "apps/desktop/src-tauri/Cargo.lock";
const CARGO_LOCK_PACKAGE = "knowlify-desktop";

export function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ?? null,
  };
}

function invalidSemverMessage(value) {
  if (typeof value === "string" && value.includes("+")) {
    return `"${value}" is not valid semver: build metadata (+...) is not allowed because the version is used as a Docker tag (${VERSION_FORMAT_HINT})`;
  }
  return `"${value}" is not valid semver (${VERSION_FORMAT_HINT})`;
}

export function collectVersions(rootDir) {
  const entries = [];

  for (const target of PACKAGE_JSON_TARGETS) {
    const json = readJson(rootDir, target.file);
    entries.push({
      id: target.id,
      label: target.file,
      version: typeof json.version === "string" ? json.version : null,
    });
  }

  const lock = readJson(rootDir, LOCK_FILE);
  entries.push({
    id: "lock-version",
    label: `${LOCK_FILE} (version)`,
    version: typeof lock.version === "string" ? lock.version : null,
  });
  for (const block of LOCK_BLOCKS) {
    const version = lock.packages?.[block.key]?.version;
    entries.push({
      id: block.id,
      label: `${LOCK_FILE} (packages["${block.key}"])`,
      version: typeof version === "string" ? version : null,
    });
  }

  entries.push({
    id: "cargo-toml",
    label: CARGO_TOML_FILE,
    version: readCargoTomlVersion(readText(rootDir, CARGO_TOML_FILE)),
  });
  entries.push({
    id: "cargo-lock",
    label: `${CARGO_LOCK_FILE} (${CARGO_LOCK_PACKAGE})`,
    version: readCargoLockVersion(readText(rootDir, CARGO_LOCK_FILE)),
  });

  return entries;
}

export function checkVersions(rootDir) {
  const entries = collectVersions(rootDir);
  const root = entries.find((entry) => entry.id === "root-package");

  if (!root || root.version === null) {
    return {
      version: null,
      ok: false,
      entries,
      issues: [{ id: "root-package", label: "package.json", message: "version field is missing" }],
    };
  }

  if (!parseSemver(root.version)) {
    return {
      version: root.version,
      ok: false,
      entries,
      issues: [
        {
          id: "root-package",
          label: "package.json",
          message: invalidSemverMessage(root.version),
        },
      ],
    };
  }

  const issues = [];
  for (const entry of entries) {
    if (entry.id === "root-package") continue;

    if (entry.version === null) {
      issues.push({ id: entry.id, label: entry.label, message: "version field is missing" });
    } else if (!parseSemver(entry.version)) {
      issues.push({
        id: entry.id,
        label: entry.label,
        message: invalidSemverMessage(entry.version),
      });
    } else if (entry.version !== root.version) {
      issues.push({
        id: entry.id,
        label: entry.label,
        message: `${entry.version} (expected ${root.version})`,
      });
    }
  }

  return { version: root.version, ok: issues.length === 0, entries, issues };
}

export function setVersion(rootDir, version) {
  if (!parseSemver(version)) throw new Error(invalidSemverMessage(version));

  const updates = [];
  const plan = (file, transform) => {
    const before = readFileSync(join(rootDir, file), "utf8");
    updates.push({ file, before, after: transform(before) });
  };

  for (const target of PACKAGE_JSON_TARGETS) {
    plan(target.file, (text) => replaceJsonVersion(text, version, target.file));
  }
  plan(LOCK_FILE, (text) => replaceLockVersions(text, version));
  plan(CARGO_TOML_FILE, (text) => replaceCargoTomlVersion(text, version));
  plan(CARGO_LOCK_FILE, (text) => replaceCargoLockVersion(text, version));

  const changed = updates.filter((update) => update.after !== update.before);
  try {
    for (const update of changed) {
      writeFileSync(join(rootDir, update.file), update.after);
    }

    const result = checkVersions(rootDir);
    if (!result.ok) {
      throw new Error(`version set failed:\n${formatIssues(result.issues)}`);
    }
  } catch (error) {
    for (const update of changed) {
      writeFileSync(join(rootDir, update.file), update.before);
    }
    throw error;
  }

  return { version, changed: changed.map((update) => update.file) };
}

export function formatIssues(issues) {
  return issues.map((issue) => `  - ${issue.label}: ${issue.message}`).join("\n");
}

function readText(rootDir, file) {
  try {
    return readFileSync(join(rootDir, file), "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
}

function readJson(rootDir, file) {
  const text = readText(rootDir, file);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`, { cause: error });
  }
}

function replaceJsonVersion(text, version, file) {
  const pattern = /^(  "version"\s*:\s*")[^"]*(")/m;
  if (!pattern.test(text)) {
    throw new Error(`cannot find a top-level "version" field in ${file}`);
  }
  return text.replace(pattern, `$1${version}$2`);
}

function replaceLockVersions(text, version) {
  const rootVersionPattern = /^(  "version"\s*:\s*")[^"]*(")/m;
  if (!rootVersionPattern.test(text)) {
    throw new Error(`cannot find the top-level version field in ${LOCK_FILE}`);
  }

  let updated = text.replace(rootVersionPattern, `$1${version}$2`);

  for (const block of LOCK_BLOCKS) {
    const headerPattern = new RegExp(`^(\\s*)"${escapeRegExp(block.key)}"\\s*:\\s*\\{`, "m");
    const header = headerPattern.exec(updated);
    if (!header) {
      throw new Error(`cannot find packages["${block.key}"] in ${LOCK_FILE}`);
    }

    const openIndex = updated.indexOf("{", header.index);
    const closeIndex = findMatchingBrace(updated, openIndex);
    if (closeIndex === -1) {
      throw new Error(`cannot find the end of packages["${block.key}"] in ${LOCK_FILE}`);
    }

    const propertyIndent = `${header[1]}  `;
    const versionPattern = new RegExp(
      `^(${escapeRegExp(propertyIndent)}"version"\\s*:\\s*")[^"]*(")`,
      "m",
    );
    const blockText = updated.slice(openIndex, closeIndex + 1);
    if (!versionPattern.test(blockText)) {
      throw new Error(`cannot find the version field of packages["${block.key}"] in ${LOCK_FILE}`);
    }

    const replacedBlock = blockText.replace(versionPattern, `$1${version}$2`);
    updated = updated.slice(0, openIndex) + replacedBlock + updated.slice(closeIndex + 1);
  }

  return updated;
}

function replaceCargoTomlVersion(text, version) {
  const header = /^\[package\]\s*$/m.exec(text);
  if (!header) throw new Error(`cannot find [package] in ${CARGO_TOML_FILE}`);

  const start = header.index + header[0].length;
  const rest = text.slice(start);
  const nextSection = /^\s*\[/m.exec(rest);
  const end = nextSection ? start + nextSection.index : text.length;

  const section = text.slice(start, end);
  const pattern = /^(version\s*=\s*")[^"]*(")/m;
  if (!pattern.test(section)) {
    throw new Error(`cannot find the version field of [package] in ${CARGO_TOML_FILE}`);
  }

  return text.slice(0, start) + section.replace(pattern, `$1${version}$2`) + text.slice(end);
}

function replaceCargoLockVersion(text, version) {
  const pattern = new RegExp(
    `^(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(CARGO_LOCK_PACKAGE)}"\\r?\\nversion = ")[^"]*(")`,
    "m",
  );
  if (!pattern.test(text)) {
    throw new Error(`cannot find the ${CARGO_LOCK_PACKAGE} package in ${CARGO_LOCK_FILE}`);
  }
  return text.replace(pattern, `$1${version}$2`);
}

function readCargoTomlVersion(text) {
  const header = /^\[package\]\s*$/m.exec(text);
  if (!header) return null;

  const start = header.index + header[0].length;
  const rest = text.slice(start);
  const nextSection = /^\s*\[/m.exec(rest);
  const end = nextSection ? start + nextSection.index : text.length;
  const match = /^version\s*=\s*"([^"]*)"/m.exec(text.slice(start, end));
  return match?.[1] ?? null;
}

function readCargoLockVersion(text) {
  const pattern = new RegExp(
    `^\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(CARGO_LOCK_PACKAGE)}"\\r?\\nversion = "([^"]*)"`,
    "m",
  );
  return pattern.exec(text)?.[1] ?? null;
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runCli(argv) {
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const [command, ...args] = argv;

  if (command === "check" && args.length === 0) {
    const result = checkVersions(rootDir);
    if (result.ok) {
      console.log(`Version check passed: ${result.version} across ${result.entries.length} targets.`);
      return 0;
    }

    const expected = result.version === null ? "" : ` (expected ${result.version})`;
    console.error(`Version check failed${expected}:`);
    console.error(formatIssues(result.issues));
    return 1;
  }

  if (command === "set" && args.length === 1) {
    try {
      const result = setVersion(rootDir, args[0]);
      if (result.changed.length === 0) {
        console.log(`All version targets already at ${result.version}.`);
      } else {
        console.log(`Updated ${result.changed.length} file(s) to ${result.version}:`);
        for (const file of result.changed) console.log(`  - ${file}`);
      }
      return 0;
    } catch (error) {
      console.error(`version: ${error.message}`);
      return 1;
    }
  }

  console.error("Usage: node scripts/version.mjs check | set MAJOR.MINOR.PATCH[-prerelease]");
  return 2;
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  process.exitCode = runCli(process.argv.slice(2));
}
