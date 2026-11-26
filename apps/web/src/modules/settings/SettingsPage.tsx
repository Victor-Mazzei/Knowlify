import { Suspense, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../../services/api";
import type { Credentials } from "../../types";
import { SettingsNav } from "./SettingsNav";
import { useShareAvailable } from "./share/useShare";
import {
  isSettingsSection,
  SETTINGS_SECTION_COMPONENTS,
  SETTINGS_SECTIONS,
  type SettingsSectionProps,
} from "./settingsSections";

function SettingsSectionFallback() {
  return (
    <div className="settings-section-skeleton" role="status">
      <span className="visually-hidden">Loading section…</span>
      <div className="setting-card settings-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

type SettingsPageProps = {
  credentials: Credentials;
  onLogout: () => void;
  onCredentialsChange?: (credentials: Credentials) => void;
};

/**
 * One section at a time. The rail and the page title stay mounted while the
 * active card chunk loads, so switching sections never shifts the shell.
 */
export function SettingsPage({ credentials, onLogout, onCredentialsChange = () => {} }: SettingsPageProps) {
  const params = useParams<{ section: string }>();
  const section = isSettingsSection(params.section) ? params.section : null;
  const api = useApi(credentials, onLogout);
  const shareAvailable = useShareAvailable();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const lastSection = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const title = section ? SETTINGS_SECTIONS[section].label : "Section not found";

  useEffect(() => {
    const changed = lastSection.current !== null && lastSection.current !== section;
    lastSection.current = section;
    titleRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (changed) setAnnouncement(`${title} section`);
  }, [section, title]);

  const ActiveSection = section ? SETTINGS_SECTION_COMPONENTS[section] : null;
  const sectionProps: SettingsSectionProps = { api, credentials, onLogout, onCredentialsChange };

  return (
    <main className="library settings">
      <div className="settings-layout">
        <SettingsNav active={section} hiddenSections={shareAvailable ? undefined : ["network"]} />
        <div className="settings-panel">
          <div className="intro settings-intro">
            <p className="eyebrow">Settings</p>
            <h1 id="settings-section-title" ref={titleRef} tabIndex={-1}>
              {title}
            </h1>
            <p className="lede">
              {section
                ? SETTINGS_SECTIONS[section].description
                : "This settings section does not exist. Pick another one from the menu."}
            </p>
          </div>
          <p className="visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>
          {ActiveSection ? (
            <Suspense fallback={<SettingsSectionFallback />}>
              <ActiveSection {...sectionProps} />
            </Suspense>
          ) : (
            <section className="setting-card settings-missing" aria-labelledby="settings-section-title">
              <h2>Nothing here</h2>
              <p className="muted">Check the address, or open the first section to get back to the settings.</p>
              <Link className="ghost bordered" to="/settings/folders">
                Go to Folders
              </Link>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
