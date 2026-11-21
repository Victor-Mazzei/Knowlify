import { AccountError, validatePassword } from "../domain/account/Password.js";
import type { CredentialVerifier } from "../ports/account.js";
import type { Clock } from "../ports/index.js";

export class Account {
  private failures = new Map<string, number[]>();
  constructor(private credentials: CredentialVerifier, private clock: Clock,
    private options: { user: string; accountLocked: boolean }) {}
  get() {
    return { user: this.options.user, canChangePassword: !this.options.accountLocked, passwordSource: this.credentials.passwordSource() };
  }
  change(current: string, next: string, ip: string): void {
    if (this.options.accountLocked) throw new AccountError("Password is managed by the app", 403);
    const cutoff = this.clock.now() - 60_000;
    for (const [address, times] of this.failures) {
      const recent = times.filter(time => time > cutoff);
      if (recent.length) this.failures.set(address, recent);
      else this.failures.delete(address);
    }
    const failures = this.failures.get(ip) ?? [];
    if (failures.length >= 5) throw new AccountError("Too many password attempts", 429);
    if (!this.credentials.verify(this.options.user, current)) {
      this.failures.set(ip, [...failures, this.clock.now()]);
      throw new AccountError("Current password is incorrect", 403);
    }
    validatePassword(next, this.credentials.verify(this.options.user, next));
    this.credentials.replace(next);
    this.failures.delete(ip);
  }
}
