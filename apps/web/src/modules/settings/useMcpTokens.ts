import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoDismiss } from "../../components/useAutoDismiss";
import { ApiError, formatError } from "../../services/api";
import { isMcpDisabled, isMcpUnavailable, type McpApi } from "./mcpApi";
import {
  MCP_DEFAULT_PATH,
  MCP_TOKEN_LIMIT,
  type McpCreatedToken,
  type McpScope,
  type McpToken,
  type McpTokensView,
} from "./mcpTypes";

export type McpStatus = "loading" | "ready" | "disabled" | "hidden" | "error";

const withoutSecret = (created: McpCreatedToken): McpToken => ({
  id: created.id,
  name: created.name,
  prefix: created.prefix,
  scope: created.scope,
  createdAt: created.createdAt,
  lastUsedAt: created.lastUsedAt,
});

const disabledView = (view: McpTokensView | null): McpTokensView => ({
  enabled: false,
  path: view?.path ?? MCP_DEFAULT_PATH,
  items: view?.items ?? [],
});

export function useMcpTokens(client: McpApi) {
  const [view, setView] = useState<McpTokensView | null>(null);
  const [status, setStatus] = useState<McpStatus>("loading");
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [created, setCreated] = useState<McpCreatedToken | null>(null);
  const requestId = useRef(0);
  useAutoDismiss(notice, setNotice);

  const load = useCallback(
    async (mode: "load" | "silent") => {
      const request = ++requestId.current;
      if (mode === "load") {
        setStatus("loading");
        setLoadError("");
      }
      try {
        const next = await client.get();
        if (request !== requestId.current) return;
        setView(next);
        setStatus(next.enabled ? "ready" : "disabled");
      } catch (reason: unknown) {
        if (request !== requestId.current) return;
        if (isMcpDisabled(reason)) {
          setView((previous) => disabledView(previous));
          setStatus("disabled");
          return;
        }
        if (isMcpUnavailable(reason)) {
          setStatus("hidden");
          return;
        }
        if (mode === "load") {
          setLoadError(formatError(reason));
          setStatus("error");
        } else {
          setError(formatError(reason));
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void load("load");
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const reload = useCallback(() => void load("load"), [load]);

  const create = useCallback(
    async (name: string, scope: McpScope): Promise<boolean> => {
      setCreating(true);
      setError("");
      setNotice("");
      try {
        const next = await client.create({ name, scope });
        setView((previous) =>
          previous ? { ...previous, items: [withoutSecret(next), ...previous.items] } : previous,
        );
        setCreated(next);
        return true;
      } catch (reason: unknown) {
        if (isMcpDisabled(reason)) {
          setView((previous) => disabledView(previous));
          setStatus("disabled");
        } else if (reason instanceof ApiError && reason.status === 409 && reason.code === "token_limit_reached") {
          setError(`You can have up to ${MCP_TOKEN_LIMIT} active tokens. Revoke one to create another.`);
        } else {
          setError(formatError(reason));
        }
        return false;
      } finally {
        setCreating(false);
      }
    },
    [client],
  );

  const revoke = useCallback(
    async (id: string) => {
      setRevokingId(id);
      setError("");
      setNotice("");
      try {
        await client.revoke(id);
        setView((previous) =>
          previous ? { ...previous, items: previous.items.filter((token) => token.id !== id) } : previous,
        );
        setNotice("Token revoked.");
      } catch (reason: unknown) {
        if (reason instanceof ApiError && reason.status === 404 && reason.code !== "mcp_disabled") {
          // A stale row: the token was already gone, so the end state is the same.
          setView((previous) =>
            previous ? { ...previous, items: previous.items.filter((token) => token.id !== id) } : previous,
          );
          setNotice("Token revoked.");
        } else if (isMcpDisabled(reason)) {
          setView((previous) => disabledView(previous));
          setStatus("disabled");
        } else {
          setError(formatError(reason));
        }
      } finally {
        setRevokingId(null);
      }
    },
    [client],
  );

  const dismissReveal = useCallback(() => setCreated(null), []);

  return {
    view,
    status,
    loadError,
    error,
    notice,
    creating,
    revokingId,
    created,
    limitReached: (view?.items.length ?? 0) >= MCP_TOKEN_LIMIT,
    create,
    revoke,
    dismissReveal,
    reload,
  };
}

export type McpTokensState = ReturnType<typeof useMcpTokens>;
