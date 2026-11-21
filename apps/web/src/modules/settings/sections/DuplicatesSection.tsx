import { DuplicatesCard } from "../../duplicates/DuplicatesCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function DuplicatesSection({ api }: SettingsSectionProps) {
  return <DuplicatesCard api={api} />;
}
