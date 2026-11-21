import { useCallback, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { IndexEnqueueRequest, IndexEnqueueResponse } from "./types";

export type EnqueueState = {
  enqueue: (bookIds: string[], vectors?: boolean) => Promise<IndexEnqueueResponse | null>;
  busy: boolean;
  error: string;
  /** Result of the last successful request; null before the first one. */
  result: IndexEnqueueResponse | null;
};

/** Queues books at priority 1, optionally upgrading them to vectors. */
export function useEnqueue(api: ApiFn): EnqueueState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<IndexEnqueueResponse | null>(null);

  const enqueue = useCallback(
    async (bookIds: string[], vectors = true): Promise<IndexEnqueueResponse | null> => {
      setBusy(true);
      setError("");
      setResult(null);
      try {
        const body: IndexEnqueueRequest = { bookIds, vectors };
        const response = await api("/api/index/enqueue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const next = (await response.json()) as IndexEnqueueResponse;
        setResult(next);
        return next;
      } catch (cause) {
        setError(formatError(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  return { enqueue, busy, error, result };
}
