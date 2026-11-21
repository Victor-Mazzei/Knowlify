import { useLayoutEffect, useMemo } from "react";
import type { ApiFn } from "./dialogs";

/**
 * One local session identity per credential-scoped API closure. `useApi`
 * returns a new closure when the credentials (or the session-bound 401
 * callback) change, so a scope tells late answers and late 401s from a previous
 * session apart from the current one.
 */
export type SessionScope = {
  /** Controller that owns the requests in this session. */
  readonly controller: AbortController;
  /** False once the API closure was replaced or the component unmounted. */
  isActive(): boolean;
};

type MutableSessionScope = SessionScope & {
  /** Rebuilds the controller after React's simulated unmount/remount. */
  restart(): void;
  dispose(): void;
};

/** A response belongs to the session only while its scope and controller are the current ones. */
export function isCurrentSession(scope: SessionScope, controller: AbortController): boolean {
  return scope.isActive() && scope.controller === controller;
}

export function useSessionScope(api: ApiFn): SessionScope {
  const scope = useMemo<MutableSessionScope>(() => {
    let controller = new AbortController();
    let active = true;
    return {
      get controller() {
        return controller;
      },
      isActive: () => active,
      restart() {
        controller = new AbortController();
        active = true;
      },
      dispose() {
        active = false;
        controller.abort();
      },
    };
  }, [api]);
  useLayoutEffect(() => {
    // StrictMode mounts, unmounts and mounts again: the second mount needs a
    // live controller, while the aborted request keeps the discarded one.
    if (!scope.isActive()) scope.restart();
    return () => scope.dispose();
  }, [scope]);
  return scope;
}
