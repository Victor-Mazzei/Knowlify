/**
 * Domain errors carry an optional machine-readable `code` and extra details that the HTTP
 * layer merges into the error body (`{ message, code?, ...details }`). The four subclass
 * mappings (400/404/409) stay the same.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {}
export class ValidationError extends DomainError {}
export class ConflictError extends DomainError {}
