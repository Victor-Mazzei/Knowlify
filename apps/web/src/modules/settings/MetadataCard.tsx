import { useMemo } from "react";
import type { FormEvent } from "react";
import type { ApiFn } from "../../components/dialogs";
import { useConfirm } from "../../components/dialogs";
import { metadataSettingsApi } from "./metadataSettingsApi";
import type { MetadataSettingsView } from "./metadataTypes";
import { useMetadataSettings } from "./useMetadataSettings";
import "./metadata.css";

const TITLE_ID = "set-metadata";

function statusOf(view: MetadataSettingsView) {
  if (view.locked) return { state: "locked", label: "Managed by server" };
  if (view.googleBooks.keyState === "unreadable") return { state: "attention", label: "Needs attention" };
  if (!view.lookupEnabled) return { state: "idle", label: "Off" };
  return { state: "ready", label: "On" };
}

function keyLabel(view: MetadataSettingsView) {
  if (view.googleBooks.keyState === "unreadable") return "Key unreadable";
  if (view.googleBooks.source === "env") return "Server key";
  if (view.googleBooks.source === "user") return "Your key";
  return "No key";
}

function placeholderFor(view: MetadataSettingsView) {
  if (view.googleBooks.keyState === "unreadable") return "Enter the key again";
  if (view.googleBooks.source === "user") return "Leave blank to keep the saved key";
  if (view.googleBooks.source === "env") return "Paste a key to override the server key";
  return "Paste your Google Books API key";
}

function helpFor(view: MetadataSettingsView) {
  if (view.googleBooks.keyState === "unreadable") {
    return "The saved key can't be decrypted. Replace it to keep using Google Books.";
  }
  if (view.googleBooks.source === "user") return "The saved key is never shown. Saving a new key replaces it.";
  if (view.googleBooks.source === "env") return "The server key is never shown here.";
  return "Optional. Without a key, Google Books requests are unauthenticated and may be rate-limited.";
}

function Providers({ view }: { view: MetadataSettingsView }) {
  return (
    <ul className="meta-providers" aria-label="Metadata providers">
      <li className="meta-provider">
        <span className="meta-provider-name">Open Library</span>
        <span className="meta-provider-role">Default source</span>
        <span className="meta-chip" data-tone="on">Always on</span>
      </li>
      <li className="meta-provider">
        <span className="meta-provider-name">Google Books</span>
        <span className="meta-provider-role">Fallback when Open Library fails or finds nothing</span>
        <span
          className="meta-chip"
          data-tone={view.googleBooks.keyState === "unreadable" ? "warn" : undefined}
        >
          {keyLabel(view)}
        </span>
      </li>
    </ul>
  );
}

/** Settings card: online lookup toggle and the Google Books fallback key. */
export function MetadataCard({ api }: { api: ApiFn }) {
  const client = useMemo(() => metadataSettingsApi(api), [api]);
  const state = useMetadataSettings(client);
  const { ask, dialog } = useConfirm();

  async function removeKey() {
    const ok = await ask({
      title: "Remove the saved Google Books key?",
      message:
        "Google Books lookups will use the server key when one is configured, or no key at all. This cannot be undone.",
      confirmLabel: "Remove key",
      danger: true,
    });
    if (ok) await state.removeKey();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void state.save();
  }

  if (state.status === "loading") {
    return (
      <section className="setting-card meta-card" aria-labelledby={TITLE_ID}>
        <h2 id={TITLE_ID}>Metadata lookup</h2>
        <p className="muted" role="status">Loading metadata settings…</p>
        <div className="meta-skeleton" aria-hidden="true"><span /><span /></div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="setting-card meta-card" aria-labelledby={TITLE_ID}>
        <h2 id={TITLE_ID}>Metadata lookup</h2>
        <p className="error" role="alert">{state.loadError}</p>
        <button className="ghost bordered" onClick={state.reload}>Try again</button>
      </section>
    );
  }

  if (state.status === "unavailable") {
    return (
      <section className="setting-card meta-card" aria-labelledby={TITLE_ID}>
        <h2 id={TITLE_ID}>Metadata lookup</h2>
        <p className="muted">Book details and covers can be searched in Open Library and Google Books.</p>
        <p className="meta-note">
          This server does not expose the lookup settings, so they cannot be changed from the app.
        </p>
      </section>
    );
  }

  const view = state.view;
  if (!view) return null;
  const status = statusOf(view);
  const canRemove = view.googleBooks.source === "user" && view.googleBooks.hasKey;
  const disabled = view.locked || state.busy !== null;

  return (
    <section className="setting-card meta-card" aria-labelledby={TITLE_ID}>
      <div className="meta-head">
        <div>
          <h2 id={TITLE_ID}>Metadata lookup</h2>
          <p className="muted">Fill gaps in a book's title, author, ISBN and cover from online catalogs.</p>
        </div>
        <span className="meta-state" data-state={status.state}>{status.label}</span>
      </div>

      <Providers view={view} />
      <p className="meta-privacy">
        Title, author and ISBN are sent to Open Library and, only if it fails or finds nothing, to Google Books.
        Lookups only happen when you ask for them from a book's metadata dialog.
      </p>

      <form className="meta-form" onSubmit={submit} noValidate>
        <div className="meta-toggle-row">
          <div>
            <strong id="meta-lookup-label">Enable online metadata lookup</strong>
            <p className="muted">When off, only the details stored with the file are used.</p>
          </div>
          <button
            type="button"
            className="meta-switch"
            role="switch"
            aria-checked={state.draft.lookupEnabled}
            aria-labelledby="meta-lookup-label"
            disabled={disabled}
            onClick={() => state.setEnabled(!state.draft.lookupEnabled)}
          >
            <span aria-hidden="true" />
            <span className="visually-hidden">{state.draft.lookupEnabled ? "On" : "Off"}</span>
          </button>
        </div>

        <div className="meta-field">
          <div className="meta-label-row">
            <label htmlFor="google-books-key">Google Books API key</label>
            {view.googleBooks.source === "user" && view.googleBooks.keyState === "ok" && (
              <span className="meta-badge">Saved</span>
            )}
          </div>
          {view.googleBooks.source === "env" && (
            <p className="meta-env">Using the server key (environment). Saving a key here overrides it.</p>
          )}
          {view.googleBooks.keyState === "unreadable" && (
            <p className="error meta-inline" role="alert">
              The saved Google Books key can't be read. Enter it again and save.
            </p>
          )}
          <div className="meta-input-row">
            <input
              id="google-books-key"
              type={state.showKey ? "text" : "password"}
              value={state.draft.key}
              placeholder={placeholderFor(view)}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              aria-invalid={state.fieldError ? true : undefined}
              aria-describedby={state.fieldError ? "google-books-key-error" : "google-books-key-help"}
              onChange={(event) => state.setKey(event.target.value)}
            />
            <button
              type="button"
              className="ghost bordered meta-show"
              aria-pressed={state.showKey}
              disabled={disabled}
              onClick={() => state.setShowKey(!state.showKey)}
            >
              {state.showKey ? "Hide" : "Show"}
            </button>
          </div>
          {state.fieldError && (
            <p id="google-books-key-error" className="meta-field-error" role="alert">
              {state.fieldError}
            </p>
          )}
          <p id="google-books-key-help" className="meta-help">{helpFor(view)}</p>
        </div>

        <details className="meta-details">
          <summary>How to get a Google Books key</summary>
          <p>
            Create an API key in Google Cloud with the Books API enabled, then paste it here. The key is stored
            encrypted and is never shown again.{" "}
            <a href="https://developers.google.com/books/docs/v1/using#APIKey" target="_blank" rel="noopener noreferrer">
              Google Books API documentation
            </a>
          </p>
        </details>

        {view.locked && (
          <p className="meta-note">Managed by the server environment. Ask the server owner to change these settings.</p>
        )}

        <div className="meta-actions">
          <button className="primary" type="submit" disabled={!state.dirty || disabled}>
            {state.busy === "save" ? "Saving…" : "Save changes"}
          </button>
          {canRemove && (
            <button
              type="button"
              className="ghost bordered"
              disabled={disabled}
              onClick={() => void removeKey()}
            >
              {state.busy === "remove" ? "Removing…" : "Remove key"}
            </button>
          )}
          <div className="meta-feedback" aria-live="polite">
            {state.notice && <p className="notice" role="status">{state.notice}</p>}
            {state.error && <p className="error" role="alert">{state.error}</p>}
          </div>
        </div>
      </form>
      {dialog}
    </section>
  );
}
