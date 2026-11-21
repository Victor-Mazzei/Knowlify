import { McpCard } from "../McpCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function McpSection({ api }: SettingsSectionProps) {
  return <McpCard api={api} />;
}
