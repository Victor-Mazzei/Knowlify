import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { Tag, TagColor, TagWithCount } from "../../types";
import { createTag, deleteTag, listTags, updateTag } from "./tagsApi";

export type TagsState = {
  tags: TagWithCount[];
  loading: boolean;
  error: string;
  /** The server predates the tags contract; the UI stays hidden. */
  unavailable: boolean;
  reload: () => void;
  create: (name: string, color?: TagColor) => Promise<Tag>;
  update: (id: string, change: { name?: string; color?: TagColor }) => Promise<Tag>;
  remove: (id: string) => Promise<void>;
};

const byName = (a: Tag, b: Tag) => a.name.localeCompare(b.name);

/** Shared tag cache for the library and the Settings manager. */
export function useTags(api: ApiFn, options: { enabled?: boolean } = {}): TagsState {
  const enabled = options.enabled !== false;
  const [tags, setTags] = useState<TagWithCount[]>([]);
  const [loading, setLoading] = useState(enabled);
  // The first read settles asynchronously. `loaded` lets callers tell "empty list"
  // apart from "the list has not arrived yet" on the render that enables the hook.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const loaded = await listTags((path, init) => api(path, { ...init, signal: controller.signal }));
        if (controller.signal.aborted) return;
        setTags([...loaded].sort(byName));
        setError("");
        setUnavailable(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && "status" in e && (e as { status?: unknown }).status === 404) {
          setUnavailable(true);
        } else {
          setError(formatError(e));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoaded(true);
          setLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [api, enabled, token]);

  const create = useCallback(
    async (name: string, color?: TagColor) => {
      const tag = await createTag(api, { name, ...(color ? { color } : {}) });
      setTags((current) => [...current.filter((entry) => entry.id !== tag.id), { ...tag, count: 0 }].sort(byName));
      return tag;
    },
    [api],
  );

  const update = useCallback(
    async (id: string, change: { name?: string; color?: TagColor }) => {
      const tag = await updateTag(api, id, change);
      setTags((current) =>
        current.map((entry) => (entry.id === id ? { ...tag, count: entry.count } : entry)).sort(byName),
      );
      return tag;
    },
    [api],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteTag(api, id);
      setTags((current) => current.filter((entry) => entry.id !== id));
    },
    [api],
  );

  // `loading` is still false on the render that enables the hook; a caller must
  // not read the empty list as an authoritative answer before the first read settles.
  const pending = enabled && (loading || !loaded);

  return useMemo(
    () => ({ tags, loading: pending, error, unavailable, reload, create, update, remove }),
    [create, error, pending, reload, remove, tags, unavailable, update],
  );
}
