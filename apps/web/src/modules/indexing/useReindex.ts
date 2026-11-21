import { useCallback, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { ReindexRequest, ReindexResponse, ReindexScope } from "./types";

/** Queues failed books or the whole library for reindexing. */
export function useReindex(api: ApiFn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState<number | null>(null);

  const reindex = useCallback(
    async (scope: ReindexScope): Promise<ReindexResponse | null> => {
      setBusy(true);
      setError("");
      setQueued(null);
      try {
        const body: ReindexRequest = { scope };
        const response = await api("/api/index/reindex", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as ReindexResponse;
        setQueued(result.queued);
        return result;
      } catch (cause) {
        setError(formatError(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  return { reindex, busy, error, queued };
}
