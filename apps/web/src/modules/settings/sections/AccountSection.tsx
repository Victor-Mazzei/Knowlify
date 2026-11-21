import { useState } from "react";
import { THEME_LABEL, useTheme } from "../../../components/ThemeToggle";
import { setTheme, type Theme } from "../../../services/theme";
import { AccountCard } from "../AccountCard";
import { CopyField } from "../CopyField";
import {
  FONT_KEY,
  FONT_MAX,
  FONT_MIN,
  readFontSize,
  readLibraryView,
  saveLibraryView,
  type LibraryView,
} from "../preferences";
import type { SettingsSectionProps } from "../settingsSections";

/** Account plus the preferences kept on this device and the KOReader addresses. */
export default function AccountSection({
  credentials,
  onLogout,
  onCredentialsChange,
}: SettingsSectionProps) {
  const theme = useTheme();
  const [view, setViewState] = useState<LibraryView>(readLibraryView);
  const [fontSize, setFontSize] = useState(readFontSize);
  const server = (window.__KNOWLIFY__?.apiBaseUrl ?? window.location.origin).replace(/\/$/, "");

  const chooseView = (next: LibraryView) => {
    setViewState(next);
    saveLibraryView(next);
  };
  const changeFont = (value: number) => {
    setFontSize(value);
    try {
      localStorage.setItem(FONT_KEY, String(value));
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <>
      <AccountCard
        credentials={credentials}
        onLogout={onLogout}
        onCredentialsChange={onCredentialsChange}
      />

      <section className="setting-card" aria-labelledby="set-appearance">
        <h2 id="set-appearance">Appearance</h2>
        <div className="setting-row">
          <div>
            <strong>Theme</strong>
            <p className="muted">System follows your operating system.</p>
          </div>
          <div className="seg" role="group" aria-label="Theme">
            {(["system", "light", "dark"] as Theme[]).map((value) => (
              <button key={value} aria-pressed={theme === value} onClick={() => setTheme(value)}>
                {THEME_LABEL[value]}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="setting-card" aria-labelledby="set-library">
        <h2 id="set-library">Library</h2>
        <div className="setting-row">
          <div>
            <strong>Default view</strong>
            <p className="muted">How your books are laid out.</p>
          </div>
          <div className="seg" role="group" aria-label="Default view">
            <button aria-pressed={view === "grid"} onClick={() => chooseView("grid")}>
              Grid
            </button>
            <button aria-pressed={view === "table"} onClick={() => chooseView("table")}>
              Table
            </button>
          </div>
        </div>
      </section>

      <section className="setting-card" aria-labelledby="set-reading">
        <h2 id="set-reading">Reading</h2>
        <div className="setting-row">
          <div>
            <strong>EPUB text size</strong>
            <p className="muted">Applies the next time you open a book.</p>
          </div>
          <div className="range">
            <input
              type="range"
              aria-label="EPUB text size"
              min={FONT_MIN}
              max={FONT_MAX}
              step={10}
              value={fontSize}
              onChange={(event) => changeFont(Number(event.target.value))}
            />
            <output>{fontSize}%</output>
            <button className="ghost" disabled={fontSize === 100} onClick={() => changeFont(100)}>
              Reset
            </button>
          </div>
        </div>
      </section>

      <section className="setting-card" aria-labelledby="set-devices">
        <h2 id="set-devices">Connect a device</h2>
        <p className="muted">
          In KOReader, add these addresses and sign in with your Knowlify username and password.
          {server.includes("localhost:517") ? " (In development the web page address differs from the server's; use the server's.)" : ""}
        </p>
        <CopyField label="Catalog (OPDS)" value={`${server}/opds`} />
        <CopyField label="Progress sync (KOSync)" value={`${server}/kosync`} />
      </section>
    </>
  );
}
