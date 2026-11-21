import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AesGcmSecretBox,
  LazySecretBox,
  SecretUnavailableError,
} from "../src/adapters/security/SecretBox.js";
import { SecretFile } from "../src/adapters/security/SecretFile.js";

const SECRET = "s".repeat(32);
const OTHER_SECRET = "t".repeat(32);
const roots: string[] = [];

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), "knowlify-secret-"));
  roots.push(root);
  return join(root, "secret.key");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AES-256-GCM secret box", () => {
  it("round-trips a key with a random IV and the versioned envelope", () => {
    const box = new AesGcmSecretBox(SECRET);
    const first = box.seal("sk-secret-value");
    const second = box.seal("sk-secret-value");
    expect(first).toMatch(/^v1:[A-Za-z0-9+/=]+$/);
    expect(first).not.toBe(second);
    expect(box.open(first)).toBe("sk-secret-value");
    expect(box.open(second)).toBe("sk-secret-value");
  });

  it("fails closed on tampering, truncation and unknown formats", () => {
    const box = new AesGcmSecretBox(SECRET);
    const sealed = box.seal("sk-secret-value");
    const payload = Buffer.from(sealed.slice(3), "base64");
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff;
    expect(() => box.open(`v1:${payload.toString("base64")}`)).toThrow();
    expect(() => box.open("v2:abc")).toThrow();
    expect(() => box.open("v1:short")).toThrow();
  });

  it("does not decrypt with a different secret", () => {
    const sealed = new AesGcmSecretBox(SECRET).seal("sk-secret-value");
    expect(() => new AesGcmSecretBox(OTHER_SECRET).open(sealed)).toThrow();
  });

  it("requires at least 32 characters of secret material", () => {
    expect(() => new AesGcmSecretBox("short")).toThrow(SecretUnavailableError);
  });
});

describe("secret file and lazy resolution", () => {
  it("does not create the file just by starting up", () => {
    const path = tempFile();
    const box = new LazySecretBox({ envSecret: null, file: new SecretFile(path) });
    expect(existsSync(path)).toBe(false);
    expect(() => box.open("v1:whatever")).toThrow(SecretUnavailableError);
    expect(existsSync(path)).toBe(false);

    const sealed = box.seal("sk-secret-value");
    expect(existsSync(path)).toBe(true);
    expect(box.open(sealed)).toBe("sk-secret-value");
  });

  it("creates a 32-byte file readable only by the owner (Unix)", () => {
    const path = tempFile();
    new LazySecretBox({ envSecret: null, file: new SecretFile(path) }).seal("sk-secret-value");
    expect(statSync(path).size).toBe(32);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const reopened = new LazySecretBox({ envSecret: null, file: new SecretFile(path) });
    expect(reopened.open(reopened.seal("other"))).toBe("other");
  });

  it("never touches the file when KNOWLIFY_SECRET is set", () => {
    const path = tempFile();
    const box = new LazySecretBox({ envSecret: SECRET, file: new SecretFile(path) });
    expect(box.open(box.seal("sk-secret-value"))).toBe("sk-secret-value");
    expect(existsSync(path)).toBe(false);
  });

  it("treats a corrupted or truncated secret file as unavailable", () => {
    const path = tempFile();
    writeFileSync(path, "too-short", { mode: 0o600 });
    const file = new SecretFile(path);
    expect(() => file.read()).toThrow();
    expect(() => new LazySecretBox({ envSecret: null, file }).open("v1:x")).toThrow();
  });
});
