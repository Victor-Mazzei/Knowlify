import { Navigate, useLocation } from "react-router-dom";
import { DEFAULT_SETTINGS_SECTION, sectionFromHash } from "./settingsSections";

/**
 * `/settings` has no section of its own. Hash links from older releases still
 * work: each known anchor maps to its route, and the default opens Folders.
 */
export function SettingsEntry() {
  const { hash } = useLocation();
  const section = sectionFromHash(hash) ?? DEFAULT_SETTINGS_SECTION;
  return <Navigate to={`/settings/${section}`} replace />;
}
