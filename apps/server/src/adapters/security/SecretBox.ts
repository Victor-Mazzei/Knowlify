import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { SecretBox } from "../../ports/llm-settings.js";
import { SecretFile } from "./SecretFile.js";

const FORMAT_PREFIX = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("llm_api_key", "utf8");
const HKDF_INFO = Buffer.from("knowlify/llm-key/v1", "utf8");

export const MIN_SECRET_CHARS = 32;

export class SecretUnavailableError extends Error {
  constructor() {
    super("The server secret is not available");
    this.name = "SecretUnavailableError";
  }
}

/** AES-256-GCM envelope with an HKDF-derived key. Format: `v1:<base64(iv|tag|ct)>`. */
export class AesGcmSecretBox implements SecretBox {
  private readonly key: Buffer;

  constructor(secret: Buffer | string) {
    const material = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
    if (material.length < MIN_SECRET_CHARS) throw new SecretUnavailableError();
    this.key = Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), HKDF_INFO, 32));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${FORMAT_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
  }

  open(sealed: string): string {
    if (!sealed.startsWith(FORMAT_PREFIX)) throw new Error("The stored LLM key has an unknown format");
    const payload = Buffer.from(sealed.slice(FORMAT_PREFIX.length), "base64");
    if (payload.length <= IV_BYTES + TAG_BYTES) throw new Error("The stored LLM key is invalid");
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    // Errors from the decipher must never include key material; callers treat any
    // failure as "unreadable" and disable the chat.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

interface LazySecretOptions {
  /** KNOWLIFY_SECRET, already validated (>= 32 characters) by the config loader. */
  envSecret: string | null;
  file: SecretFile;
}

/**
 * Resolves the secret on first use, so booting without a stored key never creates
 * `data/secret.key`. `open` fails closed when there is no secret; `seal` creates it.
 */
export class LazySecretBox implements SecretBox {
  private box: AesGcmSecretBox | undefined;

  constructor(private readonly options: LazySecretOptions) {
    if (options.envSecret !== null) {
      this.box = new AesGcmSecretBox(options.envSecret);
    }
  }

  seal(plaintext: string): string {
    return this.instance(true).seal(plaintext);
  }

  open(sealed: string): string {
    return this.instance(false).open(sealed);
  }

  private instance(create: boolean): AesGcmSecretBox {
    if (this.box) return this.box;
    if (this.options.envSecret !== null) {
      this.box = new AesGcmSecretBox(this.options.envSecret);
      return this.box;
    }
    const secret = create ? this.options.file.readOrCreate() : this.options.file.read();
    if (!secret) throw new SecretUnavailableError();
    this.box = new AesGcmSecretBox(secret);
    return this.box;
  }
}
