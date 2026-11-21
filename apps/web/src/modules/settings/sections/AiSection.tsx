import { LlmCard } from "../LlmCard";
import type { SettingsSectionProps } from "../settingsSections";

export default function AiSection({ api }: SettingsSectionProps) {
  return <LlmCard api={api} />;
}
