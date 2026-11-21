import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ChatStatusContext } from "../assistant/useChatStatus";
import { LlmCard } from "./LlmCard";
import { createMockLlmApi, type MockLlmScenario } from "./llmMock";

export type Call = { path: string; init?: RequestInit };

export const spyApi = (inner: ApiFn) => {
  const calls: Call[] = [];
  const api: ApiFn = (path, init) => {
    calls.push({ path, init });
    return inner(path, init);
  };
  return { api, calls };
};

export const renderCard = (api: ApiFn) => {
  const refresh = vi.fn(async () => undefined);
  const view = render(
    <ChatStatusContext.Provider value={{ status: null, loading: false, enabled: false, refresh }}>
      <LlmCard api={api} />
    </ChatStatusContext.Provider>,
  );
  return { ...view, refresh };
};

export const bodyOf = (call: Call) => {
  if (typeof call.init?.body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(call.init.body) as Record<string, unknown>;
};

export const mock = (scenario: MockLlmScenario) => createMockLlmApi({ scenario });

/** Holds one route so a test can inspect or edit the form while the request is in flight. */
export const gatedApi = (inner: ApiFn, suffix: string, method?: string) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const api: ApiFn = async (path, init) => {
    const requestMethod = (init?.method ?? "GET").toUpperCase();
    if (path.endsWith(suffix) && (!method || requestMethod === method)) await gate;
    return inner(path, init);
  };
  return { api, release };
};

export const headersDetails = () => {
  const summary = screen.getByText(/^Custom headers \(/);
  const details = summary.closest("details");
  if (!details) throw new Error("Custom headers details not found.");
  return details as HTMLDetailsElement;
};

export const openHeaders = () => {
  const details = headersDetails();
  if (!details.open) {
    details.open = true;
    fireEvent(details, new Event("toggle"));
  }
  return details;
};
