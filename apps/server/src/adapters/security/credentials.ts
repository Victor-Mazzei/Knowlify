import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { CredentialVerifier, PasswordHasher, SettingsRepository } from "../../ports/account.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const md5 = (value: string) => createHash("md5").update(value).digest("hex");

export class ScryptPasswordHasher implements PasswordHasher {
  hash(password: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
  }
  verify(password: string, encoded: string): boolean {
    const match = /^scrypt\$16384\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
    if (!match) return false;
    return timingSafeEqual(scryptSync(password, Buffer.from(match[1]!, "hex"), 64, { N: 16384, r: 8, p: 1 }), Buffer.from(match[2]!, "hex"));
  }
}

export class EffectiveCredentials implements CredentialVerifier {
  private cached?: { hash: string; digest: Buffer };
  constructor(private settings: SettingsRepository, private hasher: PasswordHasher,
    private options: { user: string; password: string; forceEnvPassword: boolean }) {}
  private storedHash(): string | undefined {
    return this.options.forceEnvPassword ? undefined : this.settings.get("password_hash");
  }
  passwordSource(): "env" | "user" { return this.storedHash() ? "user" : "env"; }
  verify(user: string, password: string): boolean {
    const hash = this.storedHash();
    let valid: boolean;
    if (!hash) valid = equal(password, this.options.password);
    else if (this.cached?.hash === hash && timingSafeEqual(digest(password), this.cached.digest)) valid = true;
    else {
      valid = this.hasher.verify(password, hash);
      // Only a fixed-size digest is retained, never a plaintext password.
      if (valid) this.cached = { hash, digest: digest(password) };
    }
    return equal(user, this.options.user) && valid;
  }
  verifyKosync(user: string, key: string): boolean {
    const expected = this.storedHash() ? this.settings.get("kosync_key") : md5(this.options.password);
    return equal(user, this.options.user) && equal(key, expected ?? "") && expected !== undefined;
  }
  replace(password: string): void {
    this.settings.set({ password_hash: this.hasher.hash(password), kosync_key: md5(password) });
    this.cached = undefined;
  }
}
