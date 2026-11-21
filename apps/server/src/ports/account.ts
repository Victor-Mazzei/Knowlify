export interface PasswordHasher {
  hash(password: string): string;
  verify(password: string, encoded: string): boolean;
}
export interface SettingsRepository {
  get(key: string): string | undefined;
  set(values: Readonly<Record<string, string>>): void;
  delete(keys: readonly string[]): void;
}
export interface CredentialVerifier {
  verify(user: string, password: string): boolean;
  verifyKosync(user: string, key: string): boolean;
  passwordSource(): "env" | "user";
  replace(password: string): void;
}
