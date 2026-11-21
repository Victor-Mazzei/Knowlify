import { LLM_API_STYLES, LLM_STYLE_PROFILES } from "./llmStyles";
import type { LlmApiStyle } from "./llmTypes";

export function LlmStyleField({
  style,
  disabled,
  onChange,
}: {
  style: LlmApiStyle;
  disabled: boolean;
  onChange: (style: LlmApiStyle) => void;
}) {
  const profile = LLM_STYLE_PROFILES[style];
  return (
    <div className="llm-field">
      <label htmlFor="llm-api-style">API style</label>
      <div className="llm-input-row">
        <select
          id="llm-api-style"
          value={style}
          disabled={disabled}
          aria-describedby="llm-api-style-help"
          onChange={(event) => onChange(event.target.value as LlmApiStyle)}
        >
          {LLM_API_STYLES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <span className="llm-help" id="llm-api-style-help">{profile.styleHelp}</span>
      {profile.maxTokensWarning && (
        <span className="llm-help llm-help-warn">{profile.maxTokensWarning}</span>
      )}
    </div>
  );
}
