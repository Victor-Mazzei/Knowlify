import { AboutCard } from "../AboutCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function AboutSection({ api }: SettingsSectionProps) {
  return <AboutCard api={api} />;
}
