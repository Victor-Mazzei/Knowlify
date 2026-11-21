import { IgnoredBooksCard } from "../../ignored/IgnoredBooksCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function IgnoredBooksSection({ api }: SettingsSectionProps) {
  return <IgnoredBooksCard api={api} />;
}
