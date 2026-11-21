import { LLM_LIMITS, type LlmSettingsView } from "./llmTypes";
import { llmFieldId, type LlmField, type LlmFieldErrors } from "./llmForm";
import { LLM_STYLE_PROFILES } from "./llmStyles";
import { LlmHeadersEditor } from "./LlmHeadersEditor";
import { LlmStyleField } from "./LlmStyleField";
import type { LlmSettingsState } from "./useLlmSettings";

const describedBy = (field: LlmField, help: string, errors: LlmFieldErrors) =>
  errors[field] ? `${llmFieldId(field)}-error` : help;

const ADVANCED = [
  { field: "maxTokens", label: "Max tokens", help: "Most tokens in one answer." },
  { field: "timeoutSec", label: "Timeout (seconds)", help: "How long to wait for the provider." },
  { field: "ratePerMin", label: "Requests per minute", help: "Chat messages allowed per minute." },
] as const;

export function LlmForm({
  llm,
  view,
  onRemoveKey,
  onReset,
}: {
  llm: LlmSettingsState;
  view: LlmSettingsView;
  onRemoveKey: () => void;
  onReset: () => void;
}) {
  const locked = view.locked;
  const disabled = locked || llm.busy !== null;
  // A pending save/reset/clear overwrites the form with the server response, so the
  // draft must not change meanwhile. Probes keep fields editable: stale results are dropped.
  const mutating = llm.busy === "save" || llm.busy === "reset" || llm.busy === "clearKey";
  const fieldsDisabled = locked || mutating;
  const profile = LLM_STYLE_PROFILES[llm.headers.style];
  return (
    <form
      className="llm-form"
      aria-busy={llm.busy !== null}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void llm.save();
      }}
    >
      {view.apiStyle !== undefined && (
        <LlmStyleField
          style={llm.headers.style}
          disabled={fieldsDisabled}
          onChange={llm.setStyle}
        />
      )}

      <div className="llm-field">
        <label htmlFor="llm-url">Server URL</label>
        <div className="llm-input-row">
          <input
            id="llm-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={profile.urlPlaceholder}
            value={llm.values.url}
            disabled={fieldsDisabled}
            aria-invalid={Boolean(llm.errors.url)}
            aria-describedby={describedBy("url", "llm-url-help", llm.errors)}
            onChange={(event) => llm.setValue("url", event.target.value)}
          />
        </div>
        {llm.errors.url ? (
          <span className="llm-field-error" id="llm-url-error">{llm.errors.url}</span>
        ) : (
          <span className="llm-help" id="llm-url-help">{profile.urlHelp}</span>
        )}
      </div>

      <div className="llm-field">
        <div className="llm-label-row">
          <label htmlFor="llm-api-key">API key</label>
          {view.hasKey && <span className="llm-badge">Saved</span>}
          {view.hasKey && (
            <button
              type="button"
              className="llm-link"
              disabled={disabled}
              onClick={() => document.getElementById("llm-api-key")?.focus()}
            >
              Replace key
            </button>
          )}
          <button
            type="button"
            className="ghost llm-show-key"
            aria-pressed={llm.showKey}
            disabled={disabled}
            onClick={() => llm.setShowKey(!llm.showKey)}
          >
            {llm.showKey ? "Hide API key" : "Show API key"}
          </button>
        </div>
        <div className="llm-input-row">
          <input
            id="llm-api-key"
            type={llm.showKey ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder={view.hasKey ? "Leave blank to keep the saved key" : "Paste the API key"}
            value={llm.values.apiKey}
            disabled={fieldsDisabled}
            aria-invalid={Boolean(llm.errors.apiKey)}
            aria-describedby={describedBy("apiKey", "llm-api-key-help", llm.errors)}
            onChange={(event) => llm.setValue("apiKey", event.target.value)}
          />
          {view.hasKey && view.source === "db" && (
            <button type="button" className="ghost bordered" disabled={disabled} onClick={onRemoveKey}>
              Remove key
            </button>
          )}
        </div>
        {llm.errors.apiKey ? (
          <span className="llm-field-error" id="llm-api-key-error">{llm.errors.apiKey}</span>
        ) : (
          <span className={llm.keyRequired ? "llm-help llm-help-warn" : "llm-help"} id="llm-api-key-help">
            {llm.keyRequired
              ? "A new key is required because the server URL changed origin."
              : profile.keyHelp}
          </span>
        )}
      </div>

      <div className="llm-field">
        <label htmlFor="llm-model">Model</label>
        <div className="llm-input-row">
          {llm.manualModel ? (
            <input
              id="llm-model"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={profile.modelPlaceholder}
              value={llm.values.model}
              disabled={fieldsDisabled}
              aria-invalid={Boolean(llm.errors.model)}
              aria-describedby={describedBy("model", "llm-model-help", llm.errors)}
              onChange={(event) => llm.setValue("model", event.target.value)}
            />
          ) : (
            <select
              id="llm-model"
              value={llm.values.model}
              disabled={fieldsDisabled}
              aria-invalid={Boolean(llm.errors.model)}
              aria-describedby={describedBy("model", "llm-model-help", llm.errors)}
              onChange={(event) => llm.setValue("model", event.target.value)}
            >
              <option value="">No model set</option>
              {llm.models.map((model) => <option key={model} value={model}>{model}</option>)}
              {llm.values.model && !llm.models.includes(llm.values.model) && (
                <option value={llm.values.model}>{llm.values.model}</option>
              )}
            </select>
          )}
          <button type="button" className="ghost bordered" disabled={disabled} onClick={() => void llm.fetchModels()}>
            {llm.busy === "models" ? "Fetching models…" : "Fetch models"}
          </button>
        </div>
        <div className="llm-field-foot">
          {llm.manualModel ? (
            llm.models.length > 0 && (
              <button type="button" className="llm-link" disabled={fieldsDisabled} onClick={() => llm.setManualModel(false)}>
                Choose from list
              </button>
            )
          ) : (
            <button type="button" className="llm-link" disabled={fieldsDisabled} onClick={() => llm.setManualModel(true)}>
              Enter model manually
            </button>
          )}
          {llm.errors.model ? (
            <span className="llm-field-error" id="llm-model-error">{llm.errors.model}</span>
          ) : (
            <span
              className={llm.modelsMessage ? "llm-help llm-help-warn" : "llm-help"}
              id="llm-model-help"
              role={llm.modelsMessage ? "status" : undefined}
            >
              {llm.modelsMessage || `Needed to turn on the assistant. You can save it empty, but chat stays off until you add a model.${profile.modelHelp ? ` ${profile.modelHelp}` : ""}`}
            </span>
          )}
        </div>
      </div>

      <details
        className="llm-advanced"
        open={llm.advancedOpen}
        onToggle={(event) => llm.setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>Advanced</summary>
        <div className="llm-advanced-grid">
          {ADVANCED.map(({ field, label, help }) => (
            <div className="llm-field" key={field}>
              <label htmlFor={`llm-${field}`}>{label}</label>
              <input
                id={`llm-${field}`}
                type="number"
                inputMode="numeric"
                min={LLM_LIMITS[field].min}
                max={LLM_LIMITS[field].max}
                value={llm.values[field]}
                disabled={fieldsDisabled}
                aria-invalid={Boolean(llm.errors[field])}
                aria-describedby={describedBy(field, `llm-${field}-help`, llm.errors)}
                onChange={(event) => llm.setValue(field, event.target.value)}
              />
              {llm.errors[field] ? (
                <span className="llm-field-error" id={`llm-${field}-error`}>{llm.errors[field]}</span>
              ) : (
                <span className="llm-help" id={`llm-${field}-help`}>
                  {help} Default {view.defaults[field]}.
                </span>
              )}
            </div>
          ))}
        </div>
      </details>

      <LlmHeadersEditor
        draft={llm.headers}
        view={view}
        url={llm.values.url}
        disabled={fieldsDisabled}
      />

      <div className="llm-actions">
        <button type="button" className="ghost bordered" disabled={llm.busy !== null} onClick={() => void llm.test()}>
          {llm.busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <div className="llm-actions-end">
          {llm.dirty && (
            <button type="button" className="ghost" disabled={disabled} onClick={llm.discard}>
              Discard changes
            </button>
          )}
          {view.source === "db" && (
            <button type="button" className="ghost" disabled={disabled} onClick={onReset}>
              Reset to environment
            </button>
          )}
          <button type="submit" className="primary" disabled={disabled || !llm.dirty}>
            {llm.busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="llm-feedback" aria-live="polite">
        {llm.testFeedback && (
          <p className="llm-test" data-tone={llm.testFeedback.tone}>{llm.testFeedback.text}</p>
        )}
        {llm.notice && <p className="notice" role="status">{llm.notice}</p>}
        {llm.error && <p className="error" role="alert">{llm.error}</p>}
      </div>
    </form>
  );
}
