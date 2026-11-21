import { MetadataCard } from "../MetadataCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function MetadataSection({ api }: SettingsSectionProps) {
  return <MetadataCard api={api} />;
}
