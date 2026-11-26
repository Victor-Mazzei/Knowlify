import { Link } from "react-router-dom";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSectionId } from "./settingsSections";

/**
 * Settings sections, grouped by the part of the product they configure. The
 * group headings stay visible on wide screens; on narrow ones the whole rail
 * turns into a single horizontal strip so the page never scrolls sideways.
 * Sections that this runtime cannot use (Network outside the desktop app) are
 * hidden and their empty groups are dropped.
 */
export function SettingsNav({
  active,
  hiddenSections = [],
}: {
  active: SettingsSectionId | null;
  hiddenSections?: readonly SettingsSectionId[];
}) {
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((id) => !hiddenSections.includes(id)),
  })).filter((group) => group.sections.length > 0);

  return (
    <nav className="settings-nav" aria-label="Settings">
      <div className="settings-nav-scroll">
        {groups.map((group) => (
          <div className="settings-nav-group" key={group.id}>
            <h2 className="settings-nav-title" id={`settings-group-${group.id}`}>
              {group.label}
            </h2>
            <ul className="settings-nav-list" aria-labelledby={`settings-group-${group.id}`}>
              {group.sections.map((id) => {
                const section = SETTINGS_SECTIONS[id];
                return (
                  <li key={id}>
                    <Link
                      to={`/settings/${id}`}
                      className="settings-nav-link"
                      aria-current={active === id ? "page" : undefined}
                    >
                      {section.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
