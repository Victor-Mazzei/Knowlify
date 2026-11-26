import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, LOCAL_ONLY_MESSAGE } from "../../services/api";
import { bodyOf, gatedApi, mock, renderCard, spyApi } from "./llmCardTestUtils";

describe("LlmCard", () => {
  it("shows a skeleton while loading and the empty state afterwards", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = mock("empty");
    const api: ApiFn = async (path, init) => {
      await gate;
      return inner(path, init);
    };
    renderCard(api);

    expect(screen.getByRole("status")).toHaveTextContent("Loading AI settings…");
    await act(async () => release());
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText(/No provider is configured yet/)).toBeInTheDocument();
  });

  it("loads a saved configuration without prefilling the API key", async () => {
    renderCard(mock("configured"));

    expect(await screen.findByDisplayValue("https://api.deepseek.com/v1")).toBeInTheDocument();
    expect(screen.getByText("Saved here")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeInTheDocument();
    const key = screen.getByLabelText("API key");
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("type", "password");
    expect(screen.getByText(/Questions and book excerpts are sent to this server/)).toBeInTheDocument();
    expect(screen.getByText("Advanced").closest("details")).not.toHaveAttribute("open");
  });

  it("puts every connection control in a styled row", async () => {
    renderCard(mock("models-ok"));
    await screen.findByLabelText("Server URL");
    const card = screen.getByRole("region", { name: "AI assistant" });
    for (const control of Array.from(card.querySelectorAll("input, select, textarea"))) {
      expect(control.closest(".llm-input-row, .llm-advanced, .llm-prompt"), control.id).not.toBeNull();
    }
    expect(screen.getByLabelText("Server URL").parentElement).toHaveClass("llm-input-row");
    expect(screen.getByLabelText("API key").parentElement).toHaveClass("llm-input-row");
    expect(screen.getByLabelText("Model").parentElement).toHaveClass("llm-input-row");

    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    const select = await screen.findByRole("combobox", { name: "Model" });
    expect(select.parentElement).toHaveClass("llm-input-row");
  });

  it("explains that a model is needed to enable the assistant", async () => {
    renderCard(mock("configured"));
    expect(await screen.findByText(/Needed to turn on the assistant/)).toBeInTheDocument();
    expect(screen.queryByText(/Optional\. Leave empty/)).not.toBeInTheDocument();
  });

  it("shows and hides the typed API key", async () => {
    renderCard(mock("configured"));
    const key = await screen.findByLabelText("API key");
    const toggle = screen.getByRole("button", { name: "Show API key" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.change(key, { target: { value: "sk-secret" } });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide API key" })).toHaveAttribute("aria-pressed", "true");
    expect(key).toHaveAttribute("type", "text");
    expect(key).toHaveValue("sk-secret");

    fireEvent.click(screen.getByRole("button", { name: "Hide API key" }));
    expect(key).toHaveAttribute("type", "password");
  });

  it("saves without sending the key when only other fields changed", async () => {
    const { api, calls } = spyApi(mock("configured"));
    const { refresh } = renderCard(api);
    const model = await screen.findByLabelText("Model");
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://api.deepseek.com/v2" } });
    fireEvent.change(model, { target: { value: "deepseek-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved. The assistant is ready.")).toBeInTheDocument();
    const put = calls.find((call) => call.init?.method === "PUT");
    expect(put).toBeDefined();
    expect(bodyOf(put!)).toMatchObject({
      url: "https://api.deepseek.com/v2",
      model: "deepseek-chat",
      maxTokens: 1024,
      timeoutSec: 120,
      ratePerMin: 20,
    });
    expect(bodyOf(put!)).not.toHaveProperty("apiKey");
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("sends a new key once and clears the field after saving", async () => {
    const { api, calls } = spyApi(mock("configured"));
    renderCard(api);
    const key = await screen.findByLabelText("API key");
    fireEvent.change(key, { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved. The assistant is ready.")).toBeInTheDocument();
    const put = calls.find((call) => call.init?.method === "PUT");
    expect(put).toBeDefined();
    expect(bodyOf(put!).apiKey).toBe("sk-new");
    expect(key).toHaveValue("");
  });

  it("disables mutable fields while saving and re-enables them afterwards", async () => {
    const { api, release } = gatedApi(mock("configured"), "/api/settings/llm", "PUT");
    renderCard(api);
    const url = await screen.findByLabelText("Server URL");
    const key = screen.getByLabelText("API key");
    const model = screen.getByLabelText("Model");
    const maxTokens = screen.getByLabelText("Max tokens");
    fireEvent.change(model, { target: { value: "deepseek-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(url).toBeDisabled();
    expect(key).toBeDisabled();
    expect(model).toBeDisabled();
    expect(maxTokens).toBeDisabled();

    await act(async () => release());
    expect(await screen.findByText("Saved. The assistant is ready.")).toBeInTheDocument();
    await waitFor(() => expect(url).toBeEnabled());
    expect(key).toBeEnabled();
    expect(model).toBeEnabled();
    expect(maxTokens).toBeEnabled();
  });

  it("explains that AI settings can only be changed on the computer", async () => {
    renderCard(mock("local_only"));
    const model = await screen.findByLabelText("Model");
    fireEvent.change(model, { target: { value: "deepseek-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(LOCAL_ONLY_MESSAGE);
    expect(screen.getByLabelText("Model")).toHaveValue("deepseek-chat");
  });

  it("shows a server URL rejection on the URL field", async () => {    const { api, calls } = spyApi(mock("blocked"));
    renderCard(api);
    const url = await screen.findByLabelText("Server URL");
    fireEvent.change(url, { target: { value: "https://api.deepseek.com/v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Private addresses are blocked/)).toBeInTheDocument();
    expect(url).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(url).toHaveFocus());
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(true);
  });

  it("marks the API key as required when the URL changes origin", async () => {
    const { api, calls } = spyApi(mock("configured"));
    renderCard(api);
    const key = await screen.findByLabelText("API key");
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://other.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/A new API key is required because the server URL changed origin/)).toBeInTheDocument();
    expect(key).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(key).toHaveFocus());
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  it("fetches models and switches between the list and manual entry", async () => {
    renderCard(mock("models-ok"));
    expect(await screen.findByLabelText("Model")).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    const select = await screen.findByRole("combobox", { name: "Model" });
    expect(within(select).getByRole("option", { name: "deepseek-chat" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "llama3.1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enter model manually" }));
    expect(screen.getByLabelText("Model")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Choose from list" }));
    expect(screen.getByRole("combobox", { name: "Model" })).toBeInTheDocument();
  });

  it("falls back to manual entry when the server does not list models", async () => {
    renderCard(mock("models-unsupported"));
    await screen.findByLabelText("Model");
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));

    expect(await screen.findByText(/This server does not list models/)).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveAttribute("type", "text");
    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
  });

  it.each([
    { scenario: "blocked" as const, text: /Private addresses are blocked/ },
    { scenario: "unauthorized" as const, text: /rejected the API key/ },
  ])("explains the $scenario probe result", async ({ scenario, text }) => {
    renderCard(mock(scenario));
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("shows the wait time when the probe is rate limited", async () => {
    renderCard(mock("rate-limited"));
    fireEvent.click(await screen.findByRole("button", { name: "Fetch models" }));
    expect(await screen.findByText(/Try again in 12 seconds/)).toBeInTheDocument();
  });

  it("removes the saved key after confirmation and leaves the URL saved", async () => {
    const { api, calls } = spyApi(mock("configured"));
    const { refresh } = renderCard(api);
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove the saved API key?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    expect(await screen.findByText("Saved API key removed.")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("https://api.deepseek.com/v1")).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith("/api/settings/llm/key") && call.init?.method === "DELETE")).toBe(true);
    expect(refresh).toHaveBeenCalled();
  });

  it("resets to the server environment after confirmation", async () => {
    const { api, calls } = spyApi(mock("configured"));
    const { refresh } = renderCard(api);
    fireEvent.click(await screen.findByRole("button", { name: "Reset to environment" }));
    const dialog = screen.getByRole("alertdialog", { name: "Reset AI settings?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset settings" }));

    expect(await screen.findByText("Reset. Using the server environment.")).toBeInTheDocument();
    expect(screen.getByText("From environment")).toBeInTheDocument();
    expect(screen.getByDisplayValue("http://localhost:11434/v1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to environment" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith("/api/settings/llm") && call.init?.method === "DELETE")).toBe(true);
    expect(refresh).toHaveBeenCalled();
  });

  it("disables mutable fields while removing the saved key", async () => {
    const { api, release } = gatedApi(mock("configured"), "/api/settings/llm/key", "DELETE");
    renderCard(api);
    const url = await screen.findByLabelText("Server URL");
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove the saved API key?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(url).toBeDisabled());
    expect(screen.getByLabelText("Model")).toBeDisabled();

    await act(async () => release());
    expect(await screen.findByText("Saved API key removed.")).toBeInTheDocument();
    await waitFor(() => expect(url).toBeEnabled());
    expect(screen.getByLabelText("Model")).toBeEnabled();
  });

  it("disables mutable fields while resetting to the environment", async () => {
    const { api, release } = gatedApi(mock("configured"), "/api/settings/llm", "DELETE");
    renderCard(api);
    const url = await screen.findByLabelText("Server URL");
    fireEvent.click(screen.getByRole("button", { name: "Reset to environment" }));
    const dialog = screen.getByRole("alertdialog", { name: "Reset AI settings?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset settings" }));

    await waitFor(() => expect(url).toBeDisabled());
    expect(screen.getByLabelText("Model")).toBeDisabled();

    await act(async () => release());
    expect(await screen.findByText("Reset. Using the server environment.")).toBeInTheDocument();
    await waitFor(() => expect(url).toBeEnabled());
    expect(screen.getByLabelText("Model")).toBeEnabled();
  });

  it("makes locked settings read-only but keeps the connection test available", async () => {
    const { api, calls } = spyApi(mock("env-locked"));
    renderCard(api);
    const url = await screen.findByLabelText("Server URL");
    expect(url).toBeDisabled();
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Managed by server")).toBeInTheDocument();
    expect(screen.getByText(/The server environment controls these settings/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected in 42 ms.")).toBeInTheDocument();
    const testCall = calls.find((call) => call.path.endsWith("/test"));
    expect(testCall).toBeDefined();
    expect(bodyOf(testCall!)).toEqual({});
  });

  it("tests an environment URL without turning it into a draft", async () => {
    const { api, calls } = spyApi(mock("env"));
    renderCard(api);
    expect(await screen.findByDisplayValue("http://localhost:11434/v1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected in 42 ms.")).toBeInTheDocument();
    const testCall = calls.find((call) => call.path.endsWith("/test"));
    expect(testCall).toBeDefined();
    expect(bodyOf(testCall!)).toEqual({});
  });

  it("sends a new key with a draft URL when testing", async () => {
    const { api, calls } = spyApi(mock("configured"));
    renderCard(api);
    await screen.findByLabelText("Server URL");
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://other.example/v1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-draft" } });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected in 42 ms.")).toBeInTheDocument();
    const testCall = calls.find((call) => call.path.endsWith("/test"));
    expect(testCall).toBeDefined();
    expect(bodyOf(testCall!)).toEqual({ url: "https://other.example/v1", apiKey: "sk-draft" });
  });

  it("does not reuse the stored key for a draft URL on another origin", async () => {
    const { api, calls } = spyApi(mock("configured"));
    renderCard(api);
    await screen.findByLabelText("Server URL");
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://other.example/v1" } });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("An API key is required for this server.")).toBeInTheDocument();
    const testCall = calls.find((call) => call.path.endsWith("/test"));
    expect(testCall).toBeDefined();
    expect(bodyOf(testCall!)).toEqual({ url: "https://other.example/v1" });
  });

  it("keeps mutable fields editable while a probe is pending", async () => {
    const { api, release } = gatedApi(mock("configured"), "/test");
    renderCard(api);
    const url = await screen.findByLabelText("Server URL");
    const key = screen.getByLabelText("API key");
    const model = screen.getByLabelText("Model");
    const maxTokens = screen.getByLabelText("Max tokens");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
    expect(url).toBeEnabled();
    expect(key).toBeEnabled();
    expect(model).toBeEnabled();
    expect(maxTokens).toBeEnabled();

    await act(async () => release());
    expect(await screen.findByText("Connected in 42 ms.")).toBeInTheDocument();
  });

  it("drops a connection test response when the draft changed while it was pending", async () => {
    const { api, release } = gatedApi(mock("configured"), "/test");
    renderCard(api);
    const model = await screen.findByLabelText("Model");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
    fireEvent.change(model, { target: { value: "deepseek-chat" } });
    await act(async () => release());

    await waitFor(() => expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled());
    expect(screen.queryByText(/Connected in 42 ms/)).not.toBeInTheDocument();
    expect(screen.queryByText(/An API key is required/)).not.toBeInTheDocument();
  });

  it("drops a model list response when the URL changed while it was pending", async () => {
    const { api, release } = gatedApi(mock("models-ok"), "/models");
    renderCard(api);
    const url = await screen.findByLabelText("Server URL");

    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    expect(screen.getByRole("button", { name: "Fetching models…" })).toBeDisabled();
    fireEvent.change(url, { target: { value: "https://api.deepseek.com/v2" } });
    await act(async () => release());

    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch models" })).toBeEnabled());
    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveAttribute("type", "text");
  });

  it("marks the API key field when the server reports a missing key", async () => {
    const inner = mock("configured");
    const api: ApiFn = async (path, init) => {
      if (path === "/api/settings/llm" && init?.method === "PUT") {
        throw new ApiError(400, "An API key is required for this server URL");
      }
      return inner(path, init);
    };
    renderCard(api);
    const url = await screen.findByLabelText("Server URL");
    const key = screen.getByLabelText("API key");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "deepseek-chat" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("An API key is required for this server URL")).toBeInTheDocument();
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(url).not.toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(key).toHaveFocus());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns when the stored key cannot be read", async () => {
    renderCard(mock("key-unreadable"));
    expect(await screen.findByText("The saved API key can't be read. Enter it again and save.")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("validates advanced fields and opens the section to the error", async () => {
    renderCard(mock("configured"));
    const maxTokens = await screen.findByLabelText("Max tokens");
    const advanced = screen.getByText("Advanced").closest("details");
    expect(advanced?.open).toBe(false);

    fireEvent.change(maxTokens, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Use a whole number from 1 to 32768.")).toBeInTheDocument();
    expect(advanced?.open).toBe(true);
    expect(maxTokens).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(maxTokens).toHaveFocus());
  });

  it("keeps the saved persona and prompt draft when saving the connection", async () => {
    const { api, calls } = spyApi(mock("custom-prompt"));
    renderCard(api);
    const textarea = await screen.findByLabelText("Prompt");
    const draft = "A draft persona that has not been saved yet.";
    fireEvent.change(textarea, { target: { value: draft } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "deepseek-chat" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved. The assistant is ready.")).toBeInTheDocument();
    expect(calls.some((call) => call.path === "/api/settings/llm" && call.init?.method === "PUT")).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(textarea).toHaveValue(draft);
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save prompt" })).toBeEnabled();
  });

  it("saves the system prompt without submitting the connection form", async () => {
    const { api, calls } = spyApi(mock("configured"));
    renderCard(api);
    const prompt = await screen.findByLabelText("Prompt");

    fireEvent.change(prompt, { target: { value: "Teach with short answers." } });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));

    expect(await screen.findByText("Saved. Custom prompt in use.")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    const put = calls.find((call) => call.path.endsWith("/api/settings/llm/prompt"));
    expect(put).toBeDefined();
    expect(bodyOf(put!)).toEqual({ systemPrompt: "Teach with short answers." });
    expect(calls.some((call) => call.path === "/api/settings/llm" && call.init?.method === "PUT")).toBe(false);
  });
});
