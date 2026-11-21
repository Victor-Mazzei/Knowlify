import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import {
  bodyOf,
  mock,
  openHeaders,
  renderCard,
  spyApi,
} from "./llmCardTestUtils";

const styleSelect = () => screen.getByRole("combobox", { name: "API style" }) as HTMLSelectElement;

describe("LlmCard API style", () => {
  it("describes each style and sends a changed style with the save", async () => {
    const { api, calls } = spyApi(mock("configured"));
    renderCard(api);
    expect(await screen.findByRole("combobox", { name: "API style" })).toHaveValue("openai");
    expect(screen.getByPlaceholderText("https://api.example.com/v1")).toBeInTheDocument();
    expect(screen.getByText(/Sent as the Authorization header/)).toBeInTheDocument();

    fireEvent.change(styleSelect(), { target: { value: "anthropic" } });
    expect(styleSelect()).toHaveValue("anthropic");
    expect(screen.getByPlaceholderText("https://api.anthropic.com")).toBeInTheDocument();
    expect(screen.getByText(/Sent as the x-api-key header/)).toBeInTheDocument();
    expect(screen.getByText(/Reasoning models count thinking toward Max tokens/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("claude-sonnet-5-5")).toBeInTheDocument();
    expect(screen.getByText(/anthropic-version defaults to 2023-06-01/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. The assistant is ready.")).toBeInTheDocument();
    const put = calls.find((call) => call.path === "/api/settings/llm" && call.init?.method === "PUT");
    expect(bodyOf(put!)).toMatchObject({ apiStyle: "anthropic" });
  });

  it("clears the model list and the test result when the style changes", async () => {
    renderCard(mock("models-ok"));
    await screen.findByLabelText("Model");
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    expect(await screen.findByRole("combobox", { name: "Model" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected in 42 ms.")).toBeInTheDocument();

    fireEvent.change(styleSelect(), { target: { value: "anthropic" } });
    expect(screen.queryByText("Connected in 42 ms.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveAttribute("type", "text");
  });

  it("rejects a header managed by the new style before saving", async () => {
    const { api, calls } = spyApi(mock("headers"));
    renderCard(api);
    await screen.findByText("Custom headers (1)");
    const details = openHeaders();
    fireEvent.click(within(details).getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByLabelText("Header 2 name"), { target: { value: "x-api-key" } });
    fireEvent.change(screen.getByLabelText("Header 2 value"), { target: { value: "secret" } });

    fireEvent.change(styleSelect(), { target: { value: "anthropic" } });
    expect(await screen.findByText("“x-api-key” is managed by the Anthropic API style.")).toBeInTheDocument();
    expect(screen.getByLabelText("Header 2 name")).toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByLabelText("Header 2 name")).toHaveFocus());
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  it("sends the style with a probe only when it changed", async () => {
    const { api, calls } = spyApi(mock("configured"));
    renderCard(api);
    await screen.findByRole("combobox", { name: "API style" });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("Connected in 42 ms.");
    const first = calls.find((call) => call.path.endsWith("/test"));
    expect(bodyOf(first!)).toEqual({});

    fireEvent.change(styleSelect(), { target: { value: "anthropic" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(calls.filter((call) => call.path.endsWith("/test"))).toHaveLength(2));
    const second = calls.filter((call) => call.path.endsWith("/test"))[1];
    expect(bodyOf(second)).toEqual({ apiStyle: "anthropic" });
  });

  it("disables the selector and the header editor while locked", async () => {
    renderCard(mock("env-locked"));
    await screen.findByRole("combobox", { name: "API style" });
    expect(styleSelect()).toBeDisabled();
    const details = openHeaders();
    expect(screen.getByLabelText("Header 1 name")).toBeDisabled();
    expect(screen.getByLabelText("Header 1 value")).toBeDisabled();
    expect(within(details).getByRole("button", { name: "Add header" })).toBeDisabled();
    expect(within(details).getByRole("button", { name: "Remove header x-tenant" })).toBeDisabled();
  });

  it("hides the new controls when an older server omits them", async () => {
    const inner = mock("configured");
    const api: ApiFn = async (path, init) => {
      const response = await inner(path, init);
      if (path === "/api/settings/llm" && (init?.method ?? "GET") === "GET") {
        const body = (await response.json()) as Record<string, unknown>;
        delete body.apiStyle;
        delete body.headers;
        delete body.headersState;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return response;
    };
    renderCard(api);
    expect(await screen.findByLabelText("Server URL")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "API style" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Custom headers \(/)).not.toBeInTheDocument();
  });
});
