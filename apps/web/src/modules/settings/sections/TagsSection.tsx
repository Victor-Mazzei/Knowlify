import { TagsCard } from "../../tags/TagsCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function TagsSection({ api }: SettingsSectionProps) {
  return <TagsCard api={api} />;
}
