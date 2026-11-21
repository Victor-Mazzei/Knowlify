import { useEffect, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { useAutoDismiss } from "../../components/useAutoDismiss";
import { ApiError, changePassword, formatError, getAccount, saveCredentials, type AccountInfo } from "../../services/api";
import type { Credentials } from "../../types";

type Props = { credentials: Credentials; onLogout: () => void; onCredentialsChange: (credentials: Credentials) => void };
type Field = "current" | "next" | "confirm";
type Values = Record<Field, string>;

const EMPTY: Values = { current: "", next: "", confirm: "" };
const MANAGED = "Your password is managed by the app.";
const CHANGED = "Password changed. Other devices, including KOReader, need the new password.";
const TOO_MANY = "Too many attempts. Try again in a minute.";

const describeError = (reason: unknown) =>
  reason instanceof ApiError && reason.status === 429 ? TOO_MANY : formatError(reason);

function validate(values: Values): { field: Field; message: string } | null {
  if (values.next.length < 8 || values.next.length > 200)
    return { field: "next", message: "New password must be between 8 and 200 characters." };
  if (values.next === values.current)
    return { field: "next", message: "New password must be different from your current password." };
  if (values.next !== values.confirm) return { field: "confirm", message: "Passwords do not match." };
  return null;
}

export function AccountCard({ credentials, onLogout, onCredentialsChange }: Props) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [values, setValues] = useState<Values>(EMPTY);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const inputs: Record<Field, RefObject<HTMLInputElement>> = { current: currentRef, next: nextRef, confirm: confirmRef };
  useAutoDismiss(message, setMessage);

  useEffect(() => {
    let mounted = true;
    void getAccount(credentials, onLogout)
      .then((value) => { if (mounted) setAccount(value); })
      .catch((reason: unknown) => { if (mounted) setLoadError(describeError(reason)); });
    return () => { mounted = false; };
  }, [credentials, onLogout]);

  const update = (key: Field, value: string) => {
    setValues((old) => ({ ...old, [key]: value }));
    setError("");
    setMessage("");
  };
  const invalid = validate(values) !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = validate(values);
    if (problem) {
      setError(problem.message);
      inputs[problem.field].current?.focus();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await changePassword(credentials, { current: values.current, next: values.next }, onLogout);
      const next = { ...credentials, pass: values.next };
      saveCredentials(next);
      onCredentialsChange(next);
      setValues(EMPTY);
      setMessage(CHANGED);
    } catch (reason: unknown) {
      setError(describeError(reason));
      alertRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="setting-card" aria-labelledby="set-account">
      <h2 id="set-account">Account</h2>
      <div className="setting-row">
        <div>
          <strong>{credentials.user}</strong>
          <p className="muted">Signed in to your Knowlify account</p>
        </div>
        <button className="ghost bordered" onClick={onLogout}>Log out</button>
      </div>
      {loadError && <p className="error" role="alert">{loadError}</p>}
      {!loadError && !account && <p className="muted" role="status">Loading account…</p>}
      {account && !account.canChangePassword && <p className="muted">{MANAGED}</p>}
      {account?.canChangePassword && (
        <form className="account-form" onSubmit={(event) => void submit(event)} noValidate>
          <label htmlFor="current-password">
            Current password
            <input ref={inputs.current} id="current-password" type="password" autoComplete="current-password"
              value={values.current} onChange={(event) => update("current", event.target.value)} />
          </label>
          <label htmlFor="new-password">
            New password
            <input ref={inputs.next} id="new-password" type="password" autoComplete="new-password"
              value={values.next} onChange={(event) => update("next", event.target.value)} />
          </label>
          <label htmlFor="confirm-password">
            Confirm new password
            <input ref={inputs.confirm} id="confirm-password" type="password" autoComplete="new-password"
              value={values.confirm} onChange={(event) => update("confirm", event.target.value)} />
          </label>
          {error && <p ref={alertRef} className="error" role="alert" tabIndex={-1}>{error}</p>}
          {message && <p className="notice" role="status">{message}</p>}
          <button className="primary" type="submit" disabled={invalid || submitting}>
            {submitting ? "Changing…" : "Change password"}
          </button>
        </form>
      )}
    </section>
  );
}
