import type { ConversationSummary } from "./types";

const formatWhen = (value: number) =>
  new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function ConversationList({
  conversations,
  activeId,
  deleteDisabledIds,
  onSelect,
  onDelete,
}: {
  conversations: ConversationSummary[];
  activeId?: string;
  /** Conversations with a live answer cannot be deleted until the stream settles. */
  deleteDisabledIds?: ReadonlySet<string>;
  onSelect: (conversation: ConversationSummary) => void;
  onDelete: (conversation: ConversationSummary) => void;
}) {
  if (conversations.length === 0)
    return <p className="muted asst-rail-empty">No conversations yet. Your questions and answers stay here.</p>;
  return (
    <ul className="asst-conversations" aria-label="Saved conversations">
      {conversations.map((conversation) => {
        const deleteDisabled = deleteDisabledIds?.has(conversation.id) ?? false;
        return (
          <li key={conversation.id} className="asst-conversation-row">
            <button
              type="button"
              className="asst-conversation"
              aria-current={conversation.id === activeId ? "true" : undefined}
              onClick={() => onSelect(conversation)}
            >
              {conversation.title}
              <small>{formatWhen(conversation.updatedAt)}</small>
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
          </li>
        );
      })}
    </ul>
  );
}
