import { useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { ChatExcerpt } from "./excerpt";
import { ChatComposer } from "./ChatComposer";
import { MessageList } from "./MessageList";
import { ModeStatus } from "./ModeStatus";
import { SessionLimitNotice } from "./SessionLimitNotice";
import { useChat } from "./useChat";
import type { ChatLimitDetails } from "./useChat";
import type { ChatMessage, ChatMode, ChatRequestScope, ChatStatus, ConversationSummary } from "./types";
import "./assistant.css";
import "./sessions.css";

export function ChatPanel({
  api,
  status,
  scope,
  conversationId,
  onConversation,
  label,
  examples,
  emptyTitle,
  emptyCopy,
  excerpt,
  onClearExcerpt,
  onUseVisibleText,
  autoFocus = true,
  disabled = false,
  onStreamingChange,
  mode = "session",
  modeSupported = false,
  useLibrary = true,
  scopeLabel = "Whole library",
  sessionTitle,
  sessionLimit,
  onSessionLimit,
  onStartNewSession,
  resumingTitle,
  registerTranscript,
}: {
  api: ApiFn;
  status: ChatStatus;
  scope: ChatRequestScope;
  conversationId?: string;
  onConversation?: (summary: ConversationSummary) => void;
  label: string;
  examples: string[];
  emptyTitle: string;
  emptyCopy?: string;
  excerpt?: ChatExcerpt;
  onClearExcerpt?: () => void;
  onUseVisibleText?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  onStreamingChange?: (streaming: boolean) => void;
  mode?: ChatMode;
  /** False on servers without `status.modes`: the panel behaves as Session only. */
  modeSupported?: boolean;
  useLibrary?: boolean;
  scopeLabel?: string;
  sessionTitle?: string;
  sessionLimit?: { limit: number; count: number } | null;
  onSessionLimit?: (details: ChatLimitDetails) => void;
  onStartNewSession?: () => void;
  resumingTitle?: string;
  registerTranscript?: (get: () => ChatMessage[]) => () => void;
}) {
  // Captured once: a new conversation id only means "load it" when the panel is (re)mounted.
  const [initialId] = useState(conversationId);
  const [draft, setDraft] = useState("");
  const effectiveMode: ChatMode = modeSupported ? mode : "session";
  const lastQuestion = useRef("");
  const chat = useChat({
    api,
    scope,
    initialConversationId: effectiveMode === "session" ? initialId : undefined,
    onConversation,
    mode: effectiveMode,
    useLibrary,
    modesSupported: modeSupported,
    onLimit: (details) => {
      setDraft(lastQuestion.current);
      onSessionLimit?.(details);
    },
    onFull: () => {
      setDraft(lastQuestion.current);
    },
  });
  const input = useRef<HTMLTextAreaElement>(null);
  const streamingChange = useRef(onStreamingChange);
  streamingChange.current = onStreamingChange;
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;
  const register = useRef(registerTranscript);
  register.current = registerTranscript;

  useEffect(() => {
    if (autoFocus && !chat.loading) input.current?.focus();
  }, [autoFocus, chat.loading]);

  useEffect(() => {
    streamingChange.current?.(chat.streaming);
  }, [chat.streaming]);

  useEffect(
    () => () => {
      streamingChange.current?.(false);
    },
    [],
  );

  useEffect(() => {
    if (!register.current) return;
    return register.current(() => messagesRef.current);
  }, []);

  if (!status.enabled) return null;

  const blockedByLimit =
    effectiveMode === "session" && !chat.loading && !chat.conversationId && Boolean(sessionLimit);
  const composerDisabled = disabled || blockedByLimit || chat.sessionFull;

  return (
    <section className="asst-chat" aria-label={label}>
      {resumingTitle && (
        <p className="asst-resume" role="status">
          <span>
            Resuming: <strong>{resumingTitle}</strong>
          </span>
          {onStartNewSession && (
            <button type="button" className="ghost bordered" onClick={onStartNewSession}>
              New session
            </button>
          )}
        </p>
      )}
      {chat.loading ? (
        <p className="muted asst-loading">Loading conversation…</p>
      ) : (
        <MessageList
          messages={chat.messages}
          streaming={chat.streaming}
          examples={examples}
          emptyTitle={emptyTitle}
          emptyCopy={emptyCopy}
          onExample={(question) => {
            setDraft(question);
            input.current?.focus();
          }}
        />
      )}
      {chat.error && (
        <div className="asst-error" role="alert">
          <span>{chat.error}</span>
          {chat.canRetry && (
            <button type="button" className="ghost bordered" onClick={chat.retry}>
              Retry
            </button>
          )}
        </div>
      )}
      {chat.stopped && (
        <div className="asst-stopped" role="status">
          <span>Answer stopped.</span>
          <button type="button" className="ghost bordered" onClick={chat.retry}>
            Retry
          </button>
        </div>
      )}
      {chat.sessionFull && (
        <div className="asst-session-full" role="status">
          <span>This session is full. Start a new session.</span>
          {onStartNewSession && (
            <button type="button" className="ghost bordered" onClick={onStartNewSession}>
              Start a new session
            </button>
          )}
        </div>
      )}
      {blockedByLimit && sessionLimit && (
        <SessionLimitNotice limit={sessionLimit.limit} count={sessionLimit.count} blocked />
      )}
      <ModeStatus
        mode={effectiveMode}
        useLibrary={useLibrary}
        scopeLabel={scopeLabel}
        sessionTitle={sessionTitle}
        hasSession={Boolean(chat.conversationId)}
      />
      {!chat.loading && (
        <ChatComposer
          draft={draft}
          onDraft={setDraft}
          onSubmit={(question) => {
            lastQuestion.current = question;
            chat.send(question, excerpt);
            setDraft("");
            onClearExcerpt?.();
          }}
          onStop={chat.stop}
          streaming={chat.streaming}
          host={status.host}
          excerpt={excerpt}
          onClearExcerpt={onClearExcerpt}
          onUseVisibleText={onUseVisibleText}
          inputRef={input}
          disabled={composerDisabled}
          mode={effectiveMode}
          useLibrary={useLibrary}
          libraryAvailable={status.scopes.library}
        />
      )}
    </section>
  );
}
