import { useEffect, useId, useRef, useState } from "react";
import type { ConversationSummary } from "./types";

export type ConversationSection = {
  id: "book" | "library";
  label: string;
  conversations: ConversationSummary[];
};

const day = 24 * 60 * 60 * 1000;

const formatWhen = (value: number) => {
  const elapsed = Date.now() - value;
  const days = Math.floor(elapsed / day);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const messageLabel = (count: number | undefined) => {
  if (count === undefined) return "";
  return `${count} ${count === 1 ? "message" : "messages"}`;
};

function ConversationRow({
  conversation,
  active,
  deleteDisabled,
  onSelect,
  onDelete,
  onRename,
}: {
  conversation: ConversationSummary;
  active: boolean;
  deleteDisabled: boolean;
  onSelect: (conversation: ConversationSummary) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onRename: (conversation: ConversationSummary, title: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const stopEditing = () => {
    setEditing(false);
    setError("");
    window.requestAnimationFrame(() => renameRef.current?.focus());
  };

  const commit = async () => {
    const next = value.trim();
    if (!next) {
      setError("A title is needed.");
      inputRef.current?.focus();
      return;
    }
    if (next.length > 80) {
      setError("Use 80 characters or fewer.");
      inputRef.current?.focus();
      return;
    }
    if (next === conversation.title) {
      stopEditing();
      return;
    }
    setSaving(true);
    setError("");
    const ok = await onRename(conversation, next);
    setSaving(false);
    if (ok) stopEditing();
    else inputRef.current?.focus();
  };

  const when = formatWhen(conversation.updatedAt);
  const messages = messageLabel(conversation.messageCount);
  return (
    <li
      className="asst-conversation-row"
      data-active={active || undefined}
      aria-current={active ? "true" : undefined}
    >
      {editing ? (
        <div className="asst-session-edit">
          <input
            ref={inputRef}
            className="asst-session-title-input"
            data-tutor-rename="true"
            value={value}
            maxLength={80}
            aria-label="Session title"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={saving}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                // The dock closes on Escape; cancel the rename instead.
                event.stopPropagation();
                stopEditing();
              }
            }}
          />
          {error && (
            <p className="asst-session-error" id={errorId} role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="asst-session-main">
          <span className="asst-session-title">{conversation.title}</span>
          <span className="asst-session-meta">
            {when}
            {messages ? ` · ${messages}` : ""}
          </span>
        </div>
      )}
      <div className="asst-session-actions">
        <button
          type="button"
          className="ghost asst-session-action"
          aria-label={`Resume session: ${conversation.title}`}
          onClick={() => onSelect(conversation)}
        >
          Resume
        </button>
        <button
          ref={renameRef}
          type="button"
          className="ghost asst-session-action"
          aria-label={`Rename session: ${conversation.title}`}
          onClick={() => {
            setValue(conversation.title);
            setEditing(true);
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="asst-conversation-delete"
          aria-label={`Delete conversation: ${conversation.title}`}
          title={
            deleteDisabled
              ? "Wait for the answer to finish before deleting this conversation."
              : `Delete “${conversation.title}”`
          }
          disabled={deleteDisabled}
          onClick={() => onDelete(conversation)}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path
              d="M3.5 5h9M6.5 5V3.5h3V5M5 5l.45 7.1a1 1 0 0 0 1 .9h3.1a1 1 0 0 0 1-.9L11 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </li>
  );
}

export function ConversationList({
  sections,
  activeId,
  deleteDisabledIds,
  onSelect,
  onDelete,
  onRename,
}: {
  sections: ConversationSection[];
  activeId?: string;
  /** Conversations with a live answer cannot be deleted until the stream settles. */
  deleteDisabledIds?: ReadonlySet<string>;
  onSelect: (conversation: ConversationSummary) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onRename: (conversation: ConversationSummary, title: string) => Promise<boolean>;
}) {
  const headingId = useId();
  const visible = sections.filter((section) => section.conversations.length > 0);
  if (visible.length === 0)
    return <p className="muted asst-rail-empty">No sessions yet. Your saved chats stay here.</p>;
  return (
    <div className="asst-sessions">
      {visible.map((section) => (
        <section className="asst-session-section" key={section.id} aria-labelledby={`${headingId}-${section.id}`}>
          <h3 className="asst-session-heading" id={`${headingId}-${section.id}`}>
            {section.label}
          </h3>
          <ul className="asst-conversations" aria-label={`${section.label} sessions`}>
            {section.conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                deleteDisabled={deleteDisabledIds?.has(conversation.id) ?? false}
                onSelect={onSelect}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
