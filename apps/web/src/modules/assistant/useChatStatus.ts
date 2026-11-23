import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { isCurrentSession, useSessionScope } from "../../components/useSessionScope";
import type { ChatStatus } from "./types";

export type ChatStatusState = {
  status: ChatStatus | null;
  loading: boolean;
  /**
   * Whether the Ask link belongs in the navigation. While the first request is
   * in flight it comes from the last confirmed status in this session, so the
   * header can reserve the slot before the response arrives.
   */
  enabled: boolean;
  refresh: () => Promise<void>;
};

const ENABLED_CACHE_KEY = "knowlify.chat.enabled";

/**
 * Incremented whenever the cache is cleared. A request that started under an
 * older generation must not write its answer back after the session ended.
 */
let cacheGeneration = 0;

/** Only the boolean is cached: chat content, host and model never touch storage. */
function readEnabledCache(): boolean {
  try {
    return sessionStorage.getItem(ENABLED_CACHE_KEY) === "1";
  } catch {
    // Blocked storage only costs the reserved slot on the next load.
    return false;
  }
}

function writeEnabledCache(enabled: boolean, generation: number) {
  if (generation !== cacheGeneration) return;
  try {
    sessionStorage.setItem(ENABLED_CACHE_KEY, enabled ? "1" : "0");
  } catch {
    // Blocked storage only costs the reserved slot on the next load.
  }
}

/** Drops the reserved Ask flag on sign-out so the next session starts unconfirmed. */
export function clearChatStatusCache(): void {
  cacheGeneration += 1;
  try {
    sessionStorage.removeItem(ENABLED_CACHE_KEY);
  } catch {
    // Blocked storage holds nothing to clear.
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNullableString = (value: unknown) => value === null || typeof value === "string";

const isMode = (value: unknown) => value === "ask" || value === "session";

const isSessionLimits = (value: unknown) =>
  isRecord(value) &&
  typeof value.maxSessions === "number" &&
  Number.isFinite(value.maxSessions) &&
  typeof value.count === "number" &&
  Number.isFinite(value.count) &&
  typeof value.maxMessages === "number" &&
  Number.isFinite(value.maxMessages);

function isChatStatus(value: unknown): value is ChatStatus {
  if (!isRecord(value)) return false;
  if (typeof value.enabled !== "boolean" || typeof value.promptVersion !== "string") return false;
  if (!isNullableString(value.model) || !isNullableString(value.host)) return false;
  if (!isRecord(value.scopes)) return false;
  if (typeof value.scopes.library !== "boolean" || typeof value.scopes.book !== "boolean") return false;
  // Both blocks are additive: an older server simply omits them and stays Session only.
  if (value.modes !== undefined && (!Array.isArray(value.modes) || !value.modes.every(isMode))) return false;
  if (value.sessionLimits !== undefined && !isSessionLimits(value.sessionLimits)) return false;
  return true;
}

/** Reads `/api/chat/status`; any failure (including an older server) leaves chat hidden. */
export function useChatStatus(api: ApiFn, requestStatus = true): ChatStatusState {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [cachedEnabled, setCachedEnabled] = useState(readEnabledCache);
  const scope = useSessionScope(api);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const controller = scope.controller;
    if (!scope.isActive()) return;
    const request = ++requestId.current;
    const generation = cacheGeneration;
    setLoading(true);
    try {
      const response = await api("/api/chat/status", { signal: controller.signal });
      const value: unknown = await response.json();
      if (request !== requestId.current || generation !== cacheGeneration || !isCurrentSession(scope, controller)) return;
      const next = isChatStatus(value) ? value : null;
      setStatus(next);
      if (next) {
        setCachedEnabled(next.enabled);
        writeEnabledCache(next.enabled, generation);
      }
    } catch {
      // An unconfigured or older server hides the feature; there is nothing to report in the UI.
      if (request === requestId.current && isCurrentSession(scope, controller)) setStatus(null);
    } finally {
      if (request === requestId.current && isCurrentSession(scope, controller)) setLoading(false);
    }
  }, [api, scope]);

  useEffect(() => {
    if (!requestStatus) return;
    void refresh();
    return () => {
      requestId.current += 1;
    };
  }, [refresh, requestStatus]);

  const enabled = status ? status.enabled : loading ? cachedEnabled : false;
  return useMemo(() => ({ status, loading, enabled, refresh }), [status, loading, enabled, refresh]);
}

/**
 * The shell already reads the chat status to decide the navigation. Pages rendered
 * inside it reuse that result instead of issuing the same request again.
 */
export const ChatStatusContext = createContext<ChatStatusState | null>(null);

export function useChatStatusContext(): ChatStatusState {
  const value = useContext(ChatStatusContext);
  if (!value) throw new Error("useChatStatusContext must be used inside the workspace status provider.");
  return value;
}

/** For surfaces rendered outside the shell that can still be covered by the provider. */
export function useChatStatusContextOptional(): ChatStatusState | null {
  return useContext(ChatStatusContext);
}
