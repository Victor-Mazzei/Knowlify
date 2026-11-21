import { useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { ChatExcerpt } from "./excerpt";
import { ChatComposer } from "./ChatComposer";
import { MessageList } from "./MessageList";
import { useChat } from "./useChat";
import type { ChatRequestScope, ChatStatus, ConversationSummary } from "./types";
import "./assistant.css";

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
}) {
  // Captured once: a new conversation id only means "load it" when the panel is (re)mounted.
  const [initialId] = useState(conversationId);
  const chat = useChat({ api, scope, initialConversationId: initialId, onConversation });
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const streamingChange = useRef(onStreamingChange);
  streamingChange.current = onStreamingChange;

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

  if (!status.enabled) return null;

  return (
    <section className="asst-chat" aria-label={label}>
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
      {!chat.loading && (
        <ChatComposer
          draft={draft}
          onDraft={setDraft}
          onSubmit={(question) => {
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
          disabled={disabled}
        />
      )}
    </section>
  );
}
