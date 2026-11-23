import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTutorSlots } from "./useTutorSlots";
import type { ConversationSummary } from "./types";

const summary = (id: string, title: string): ConversationSummary => ({
  id,
  title,
  scope: { kind: "library" },
  updatedAt: 1,
});

beforeEach(() => localStorage.clear());

describe("useTutorSlots", () => {
  it("keeps a rename that lands while an existing session is still streaming", () => {
    const { result } = renderHook(() => useTutorSlots({ modesSupported: true }));
    act(() => result.current.ensureLibrarySlot());
    act(() =>
      result.current.selectConversation({
        ...summary("c1", "Original"),
        scope: { kind: "library" },
      }),
    );
    expect(result.current.activeSlot?.conversationTitle).toBe("Original");

    act(() => result.current.renameConversation("c1", "Renamed"));
    act(() =>
      result.current.rememberConversation("library", {
        ...summary("c1", "Original"),
        scope: { kind: "library" },
      }),
    );
    expect(result.current.activeSlot?.conversationTitle).toBe("Renamed");
  });

  it("takes the server title for a new session", () => {
    const { result } = renderHook(() => useTutorSlots({ modesSupported: true }));
    act(() => result.current.ensureLibrarySlot());
    act(() =>
      result.current.rememberConversation("library", {
        ...summary("c2", "First question"),
        scope: { kind: "library" },
      }),
    );
    expect(result.current.activeSlot?.conversationId).toBe("c2");
    expect(result.current.activeSlot?.conversationTitle).toBe("First question");
  });

  it("falls back to Session when the server has no modes", () => {
    localStorage.setItem("knowlify.tutor.mode", "ask");
    const { result } = renderHook(() => useTutorSlots({ modesSupported: false }));
    act(() => result.current.ensureLibrarySlot());
    expect(result.current.activeSlot?.mode).toBe("session");
  });
});
