import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const SECRET_BYTES = 32;

/**
 * Server secret used to derive the LLM key encryption key. It is created lazily, with
 * O_EXCL and mode 0600, only when a key is first saved; the operator can instead set
 * KNOWLIFY_SECRET so the secret lives outside the data directory.
 */
export class SecretFile {
  constructor(readonly path: string) {}

  read(): Buffer | null {
    let value: Buffer;
    try {
      value = readFileSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (value.length !== SECRET_BYTES) {
      throw new Error("The LLM secret file is invalid");
    }
    return value;
  }

  readOrCreate(): Buffer {
    const existing = this.read();
    if (existing) return existing;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(this.path, randomBytes(SECRET_BYTES), { flag: "wx", mode: 0o600 });
    } catch (error) {
      // Another process may have won the O_EXCL race; reuse its file.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const created = this.read();
    if (!created) throw new Error("The LLM secret file could not be created");
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Best effort: file modes are meaningful on Unix; Windows ignores them.
    }
    return created;
  }
}
