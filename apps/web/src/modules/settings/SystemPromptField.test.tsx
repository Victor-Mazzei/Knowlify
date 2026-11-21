import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../services/api";
import { createLlmApi } from "./llmApi";
import { createMockLlmApi, initialLlmView, type MockLlmScenario } from "./llmMock";
import { SystemPromptField } from "./SystemPromptField";

type Call = { path: string; init?: RequestInit };

const bodyOf = (call: Call) => {
  expect(call.init?.body).toEqual(expect.any(String));
  return JSON.parse(call.init?.body as string) as Record<string, unknown>;
};

const setup = (scenario: MockLlmScenario = "configured") => {
  const inner = createMockLlmApi({ scenario });
  const calls: Call[] = [];
  const client = createLlmApi((path, init) => {
    calls.push({ path, init });
    return inner(path, init);
  });
  const prompt = initialLlmView(scenario).prompt;
  render(<SystemPromptField client={client} prompt={prompt} />);
  return { calls, prompt };
};

const saveCall = (calls: Call[]) => calls.find((call) => call.path.endsWith("/api/settings/llm/prompt"));

describe("SystemPromptField", () => {
  it("starts with the default persona and a disabled save", () => {
    const { prompt } = setup();
    const textarea = screen.getByLabelText("Prompt");

    expect(textarea).toHaveValue(prompt.default);
    expect(textarea).toHaveAttribute("maxlength", "4000");
    expect(textarea).toHaveAttribute("aria-describedby", "llm-prompt-help llm-prompt-count");
    expect(screen.getByText("Using default")).toBeInTheDocument();
    expect(screen.getByText(`${prompt.default.length} / 4000`)).toBeInTheDocument();
    expect(screen.getByText(/Citation and safety rules are always applied/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save prompt" })).toBeDisabled();
  });

  it("shows a saved custom persona", () => {
    const { prompt } = setup("custom-prompt");

    expect(screen.getByLabelText("Prompt")).toHaveValue(prompt.custom);
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save prompt" })).toBeDisabled();
  });

  it("updates the counter and blocks an empty prompt", () => {
    setup();
    const textarea = screen.getByLabelText("Prompt");
    const edited = "Explain simply.";

    fireEvent.change(textarea, { target: { value: edited } });
    expect(screen.getByText(`${edited.length} / 4000`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save prompt" })).toBeEnabled();

    fireEvent.change(textarea, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save prompt" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a prompt");
  });

  it("saves the edited prompt and switches to custom", async () => {
    const { calls } = setup();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Use short answers." } });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));

    expect(await screen.findByText("Saved. Custom prompt in use.")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    const put = saveCall(calls);
    expect(put).toBeDefined();
    expect(bodyOf(put!)).toEqual({ systemPrompt: "Use short answers." });
    expect(screen.getByRole("button", { name: "Save prompt" })).toBeDisabled();
  });

  it("resets a custom persona to the default and saves null", async () => {
    const { calls, prompt } = setup("custom-prompt");
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    expect(screen.getByLabelText("Prompt")).toHaveValue(prompt.default);
    expect(screen.getByText("Custom")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    expect(await screen.findByText("Saved. Using the default prompt.")).toBeInTheDocument();
    const put = saveCall(calls);
    expect(put).toBeDefined();
    expect(bodyOf(put!)).toEqual({ systemPrompt: null });
    expect(screen.getByText("Using default")).toBeInTheDocument();
  });

  it("reveals the default persona in View default", () => {
    const { prompt } = setup("custom-prompt");
    const details = screen.getByText("View default").closest("details");
    expect(details).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("View default"));
    expect(details).toHaveAttribute("open");
    expect(details!.querySelector("pre")?.textContent).toBe(prompt.default);
  });

  it("shows a server validation error", async () => {
    const inner = createMockLlmApi({ scenario: "configured" });
    const client = createLlmApi(async (path, init) => {
      if (path.endsWith("/prompt") && (init?.method ?? "GET").toUpperCase() === "PUT") {
        throw new ApiError(400, "The system prompt cannot be empty.");
      }
      return inner(path, init);
    });
    render(<SystemPromptField client={client} prompt={initialLlmView("configured").prompt} />);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The system prompt cannot be empty.");
  });

  it("locks editing when the server environment manages the prompt", () => {
    const { prompt } = setup("env-locked");
    const textarea = screen.getByLabelText("Prompt");

    expect(textarea).toBeDisabled();
    expect(screen.getByText("Managed by the server environment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeDisabled();

    const details = screen.getByText("View default").closest("details");
    fireEvent.click(screen.getByText("View default"));
    expect(details!.querySelector("pre")?.textContent).toBe(prompt.default);
  });

  it("reaches the editor and its actions with the keyboard", async () => {
    setup();
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByLabelText("Prompt")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Reset to default" })).toHaveFocus();
  });
});
