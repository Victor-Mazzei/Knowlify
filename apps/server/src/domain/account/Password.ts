export class AccountError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 429) { super(message); }
}

export function validatePassword(next: string, matchesCurrent: boolean): void {
  const length = [...next].length;
  if (length < 8 || length > 200 || /[\p{Cc}]/u.test(next)) {
    throw new AccountError("New password must contain 8–200 characters without control characters", 400);
  }
  if (matchesCurrent) throw new AccountError("New password must differ from current password", 400);
}
