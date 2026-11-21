import {
  McpServer,
  createMcpHandler,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { McpScope } from "../../domain/access/McpToken.js";
import type { Logger } from "../../ports/index.js";
import { registerBookTools } from "./tools/books.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerSearchTools } from "./tools/search.js";
import { registerStatusTools } from "./tools/status.js";
import { registerTagTools } from "./tools/tags.js";
import { UNTRUSTED_NOTICE, type McpToolDeps } from "./tools/shared.js";

const INSTRUCTIONS =
  "Knowlify exposes a local-first ebook library. Read the user's books, passages, notes and tags, "
  + "and (with a write_notes token) create notes, change book tags and mark books as favorites. "
  + `${UNTRUSTED_NOTICE} There is no delete, merge or rename tool.`;

export interface McpHandlerSet {
  /** Only read tools are registered, so a read token cannot even list write tools. */
  read: McpHttpHandler;
  /** Read tools plus create_note/add_tags_to_books/remove_tags_from_books/set_book_favorite. */
  write: McpHttpHandler;
  close(): Promise<void>;
}

export interface BuildMcpOptions {
  version: string;
  log: Logger;
  /** Same 256 KB ceiling as the Fastify route; applies when the SDK reads its own body. */
  maxRequestBodyBytes: number;
}

const buildServer = (
  deps: McpToolDeps,
  scope: McpScope,
  authInfo: AuthInfo | undefined,
  version: string,
): McpServer => {
  const server = new McpServer(
    { name: "knowlify", version },
    { instructions: INSTRUCTIONS, maxToolInputElements: 5_000 },
  );
  registerSearchTools(server, deps);
  registerBookTools(server, deps, authInfo, scope === "write_notes");
  registerNoteTools(server, deps, authInfo, scope === "write_notes");
  registerTagTools(server, deps, authInfo, scope === "write_notes");
  registerStatusTools(server, deps);
  return server;
};

/**
 * Two stateless handlers over one factory each (ADR-3). The auth gate chooses by the
 * token scope; write handlers additionally carry only the registered write tools.
 */
export function createMcpHandlers(deps: McpToolDeps, options: BuildMcpOptions): McpHandlerSet {
  const handlerFor = (scope: McpScope): McpHttpHandler =>
    createMcpHandler(
      ({ authInfo }) => buildServer(deps, scope, authInfo, options.version),
      {
        legacy: "stateless",
        maxRequestBodySize: options.maxRequestBodyBytes,
        // Never log arguments, queries or note text; the error name is enough for triage.
        onerror: (error) => options.log.warn?.(`mcp handler error (${error.name})`),
      },
    );

  const read = handlerFor("read");
  const write = handlerFor("write_notes");
  return {
    read,
    write,
    close: async () => {
      await read.close();
      await write.close();
    },
  };
}
