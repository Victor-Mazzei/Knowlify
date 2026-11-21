import { SearchIndexCard } from "../../indexing/SearchIndexCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function SearchIndexSection({ api }: SettingsSectionProps) {
  return <SearchIndexCard api={api} />;
}
