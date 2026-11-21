import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { beginTool, toolError, toolOk, type McpToolDeps } from "./shared.js";

/** Counts, embedding mode and coverage; never paths or source names. */
export function registerStatusTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "get_index_status",
    {
      title: "Get index status",
      description: "Report indexing progress, embedding mode and coverage for the library.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      beginTool("get_index_status");
      try {
        const status = deps.indexing.status();
        const total = deps.library.countBooks();
        return toolOk(deps, {
          enabled: status.enabled,
          counts: status.counts,
          search: {
            embeddings: status.search.embeddings,
            model: status.search.model,
            state: status.search.state,
            semantic: status.search.semantic,
          },
          coverage: { indexed: status.counts.ready, total },
          paused: status.paused,
          progress: status.current === null ? null : {
            bookId: status.current.bookId,
            fraction: status.current.progress,
          },
          etaSec: status.etaSec,
        });
      } catch (error) {
        return toolError(deps, error);
      }
    },
  );
}
