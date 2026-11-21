import { useCallback, useContext, useMemo } from "react";
import type { ApiFn } from "../../components/dialogs";
import { useConfirm } from "../../components/dialogs";
import { ChatStatusContext } from "../assistant/useChatStatus";
import { llmApi, type LlmApi } from "./llmApi";
import type { LlmSettingsView } from "./llmTypes";
import { LlmForm } from "./LlmForm";
import { SystemPromptField } from "./SystemPromptField";
import { useLlmSettings } from "./useLlmSettings";

const statusOf = (view: LlmSettingsView) => {
  if (view.locked) return { state: "locked", label: "Managed by server" };
  if (view.keyState === "unreadable" || view.headersState === "unreadable") {
    return { state: "attention", label: "Needs attention" };
  }
  if (!view.enabled) {
    return view.source === "none"
      ? { state: "idle", label: "Not configured" }
      : { state: "attention", label: "Needs attention" };
  }
  if (view.source === "db") return { state: "ready", label: "Saved here" };
  if (view.source === "env") return { state: "ready", label: "From environment" };
  return { state: "idle", label: "Not configured" };
};

const sourceNote = (view: LlmSettingsView) => {
  if (view.locked) {
    return "The server environment controls these settings. Test connection uses the effective configuration.";
  }
  if (view.source === "db") return "These values are saved in Knowlify and override the server environment.";
  if (view.source === "env") return "Using the server environment. Saving here stores an override.";
  return "No provider is configured yet. Add a URL and an API key to turn on the assistant.";
};

export function LlmCard({ api }: { api: ApiFn }) {
  const chat = useContext(ChatStatusContext);
  const client = useMemo<LlmApi>(() => llmApi(api), [api]);
  const onChanged = useCallback(() => {
    void chat?.refresh();
  }, [chat]);
  const llm = useLlmSettings(client, onChanged);
  const { ask, dialog } = useConfirm();

  async function removeKey() {
    const ok = await ask({
      title: "Remove the saved API key?",
      message: "The assistant stops answering until you add a key again. The URL, model and custom headers stay saved.",
      confirmLabel: "Remove key",
      danger: true,
    });
    if (ok) await llm.clearKey();
  }

  async function resetToEnvironment() {
    const ok = await ask({
      title: "Reset AI settings?",
      message:
        "This removes the saved URL, model, API key and custom headers. The server environment takes over when it is configured.",
      confirmLabel: "Reset settings",
      danger: true,
    });
    if (ok) await llm.reset();
  }

  if (llm.loading) {
    return (
      <section className="setting-card llm-card" aria-labelledby="set-llm">
        <h2 id="set-llm">AI assistant</h2>
        <p className="muted" role="status">Loading AI settings…</p>
        <div className="llm-skeleton" aria-hidden="true"><span /><span /></div>
      </section>
    );
  }

  if (llm.loadError) {
    return (
      <section className="setting-card llm-card" aria-labelledby="set-llm">
        <h2 id="set-llm">AI assistant</h2>
        <p className="error" role="alert">{llm.loadError}</p>
        <button className="ghost bordered" onClick={llm.reload}>Try again</button>
      </section>
    );
  }

  if (!llm.view) return null;
  const view = llm.view;
  const status = statusOf(view);

  return (
    <section className="setting-card llm-card" aria-labelledby="set-llm">
      <div className="llm-head">
        <div>
          <h2 id="set-llm">AI assistant</h2>
          <p className="muted">Powers questions about your books. Ask appears when a provider is ready.</p>
        </div>
        <span className="llm-state" data-state={status.state}>{status.label}</span>
      </div>
      <p className="llm-warning">Questions and book excerpts are sent to this server.</p>
      <p className="llm-note">{sourceNote(view)}</p>
      {view.keyState === "unreadable" && (
        <p className="error llm-inline-error" role="alert">
          The saved API key can't be read. Enter it again and save.
        </p>
      )}
      {view.headersState === "unreadable" && (
        <p className="error llm-inline-error" role="alert">
          The saved custom header values can't be read. Open Custom headers, enter them again and save.
        </p>
      )}
      <LlmForm
        llm={llm}
        view={view}
        onRemoveKey={() => void removeKey()}
        onReset={() => void resetToEnvironment()}
      />
      <SystemPromptField client={client} prompt={view.prompt} />
      {dialog}
    </section>
  );
}
