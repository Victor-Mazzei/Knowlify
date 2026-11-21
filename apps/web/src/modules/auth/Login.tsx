import { useState } from "react";
import type { FormEvent } from "react";
import { Logo } from "../../components/Logo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { formatError } from "../../services/api";
import type { Credentials } from "../../types";

export function Login({
  onLogin,
}: {
  onLogin: (credentials: Credentials) => Promise<void>;
}) {
  const [user, setUser] = useState(""),
    [pass, setPass] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onLogin({ user, pass });
    } catch (error) {
      setError(formatError(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <ThemeToggle />
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand">
          <Logo size={40} />
          Knowlify
        </div>
        <h1 id="login-title">
          Sign in to your <em>library</em>
        </h1>
        <p className="login-copy">Your PDFs and EPUBs, on every device.</p>
        <form onSubmit={submit}>
          <label>
            Username
            <input
              required
              value={user}
              onChange={(event) => setUser(event.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label>
            Password
            <input
              required
              type="password"
              value={pass}
              onChange={(event) => setPass(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "Checking library…" : "Enter library"}
          </button>
        </form>
      </section>
    </main>
  );
}
