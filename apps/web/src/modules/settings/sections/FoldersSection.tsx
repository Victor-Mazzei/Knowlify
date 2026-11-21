import { FoldersCard } from "../../folders/FoldersCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function FoldersSection({ api }: SettingsSectionProps) {
  return <FoldersCard api={api} />;
}
