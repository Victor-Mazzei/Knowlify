import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { ConversationSummary } from "./types";

/** The server caps a page at 200; the list is the place to see every saved session. */
const LIMIT = 200;

export type ConversationsState = {
  conversations: ConversationSummary[];
  loading: boolean;
  error: string;
  deletingIds: ReadonlySet<string>;
  remove: (id: string) => Promise<boolean>;
  rename: (id: string, title: string) => Promise<boolean>;
  refresh: () => Promise<void>;
};

/**
 * The 20 most recent conversations of one scope. The server returns the library
 * scope when `bookId` is absent and only that book's conversations otherwise;
 * keeping one scope per slot is what makes switching never hit a scope mismatch.
 */
export function useConversations({
  api,
  bookId,
  enabled,
  revision,
}: {
  api: ApiFn;
  bookId?: string;
  /** Both the chat and the scope must be available before asking the server. */
  enabled: boolean;
  /** Changes whenever a conversation is created or deleted elsewhere. */
  revision: number;
}): ConversationsState {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const itemsRef = useRef(conversations);
  const deletingRef = useRef(deletingIds);
  const deletedRef = useRef(new Set<string>());
  const requestId = useRef(0);
  itemsRef.current = conversations;
  deletingRef.current = deletingIds;

  const load = useCallback(async () => {
    const request = ++requestId.current;
    if (!enabled) {
      setConversations([]);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const query = bookId ? `?bookId=${encodeURIComponent(bookId)}&limit=${LIMIT}` : `?limit=${LIMIT}`;
      const response = await api(`/api/chat/conversations${query}`);
      const list = (await response.json()) as ConversationSummary[];
      if (request !== requestId.current) return;
      // A list response started before a delete must not bring the removed row back.
      setConversations(
        list.filter(
          (item) => !deletingRef.current.has(item.id) && !deletedRef.current.has(item.id),
        ),
      );
      setError("");
    } catch (value) {
      if (request !== requestId.current) return;
      setError(value instanceof Error ? value.message : "Conversations could not be loaded.");
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [api, bookId, enabled]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load, revision]);

  const remove = useCallback(
    async (id: string) => {
      if (deletingRef.current.has(id)) return false;
      const removed = itemsRef.current.find((item) => item.id === id);
      setDeletingIds((current) => new Set(current).add(id));
      // Remove now so the list responds immediately; restore the row if the server rejects it.
      setConversations((current) => current.filter((item) => item.id !== id));
      try {
        await api(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
        deletedRef.current.add(id);
        // A late list response may have slipped in before the delete settled.
        setConversations((current) => current.filter((item) => item.id !== id));
        return true;
      } catch (value) {
        if (removed) {
          setConversations((current) =>
            current.some((item) => item.id === id)
              ? current
              : [...current, removed].sort((a, b) => b.updatedAt - a.updatedAt),
          );
        }
        throw value;
      } finally {
        setDeletingIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [api],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      setError("");
      try {
        const response = await api(`/api/chat/conversations/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        const updated = (await response.json()) as ConversationSummary;
        setConversations((current) =>
          current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  ...updated,
                  messageCount: updated.messageCount ?? item.messageCount,
                }
              : item,
          ),
        );
        return true;
      } catch (value) {
        setError(value instanceof Error ? value.message : "The session could not be renamed.");
        return false;
      }
    },
    [api],
  );

  return { conversations, loading, error, deletingIds, remove, rename, refresh: load };
}
