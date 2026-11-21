import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import {
  bodyOf,
  headersDetails,
  mock,
  openHeaders,
  renderCard,
  spyApi,
} from "./llmCardTestUtils";

const headerValue = () => screen.getByLabelText("Header 1 value") as HTMLInputElement;

describe("LlmCard custom headers", () => {
  it("lists saved names without the values and reveals only typed text", async () => {
    renderCard(mock("headers"));
    expect(await screen.findByText("Custom headers (1)")).toBeInTheDocument();
    const details = openHeaders();

    expect(screen.getByLabelText("Header 1 name")).toHaveValue("x-session-id");
    const value = headerValue();
    expect(value).toHaveValue("");
    expect(value).toHaveAttribute("type", "password");
    expect(value).toHaveAttribute("placeholder", "Leave blank to keep the saved value");
    expect(within(details).getByText("Saved")).toBeInTheDocument();

    fireEvent.change(value, { target: { value: "typed-value" } });
    expect(within(details).queryByText("Saved")).not.toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: "Show values" }));
    expect(value).toHaveAttribute("type", "text");
    expect(value).toHaveValue("typed-value");
    expect(within(details).getByRole("button", { name: "Hide values" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the saved list when only the model changes", async () => {
    const { api, calls } = spyApi(mock("headers"));
    renderCard(api);
    fireEvent.change(await screen.findByLabelText("Model"), { target: { value: "deepseek-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved. The assistant is ready.")).toBeInTheDocument();
    const put = calls.find((call) => call.path === "/api/settings/llm" && call.init?.method === "PUT");
    expect(put).toBeDefined();
    expect(bodyOf(put!)).not.toHaveProperty("headers");
    expect(bodyOf(put!)).not.toHaveProperty("apiStyle");
    expect(screen.getByText("Custom headers (1)")).toBeInTheDocument();
  });

  it("sends the full value when a saved header value is replaced", async () => {
    const { api, calls } = spyApi(mock("headers"));
    renderCard(api);
    await screen.findByText("Custom headers (1)");
    fireEvent.change(headerValue(), { target: { value: "fresh-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved. The assistant is ready.")).toBeInTheDocument();
    const put = calls.find((call) => call.path === "/api/settings/llm" && call.init?.method === "PUT");
    expect(bodyOf(put!).headers).toEqual([{ name: "x-session-id", value: "fresh-value" }]);
  });

  it("blocks a rename until a new value is entered and focuses the field", async () => {
    const { api, calls } = spyApi(mock("headers"));
    renderCard(api);
    await screen.findByText("Custom headers (1)");
    fireEvent.change(screen.getByLabelText("Header 1 name"), { target: { value: "x-renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Enter a value.")).toBeInTheDocument();
    expect(headerValue()).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(headerValue()).toHaveFocus());
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  it("requires saved values again after the server origin changes", async () => {
    const { api, calls } = spyApi(mock("headers"));
    renderCard(api);
    await screen.findByText("Custom headers (1)");
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://other.example/v1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Enter the value again because the server URL changed origin/)).toBeInTheDocument();
    await waitFor(() => expect(headerValue()).toHaveFocus());
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  it("shows a server header rejection inline and opens the editor", async () => {
    const inner = mock("headers");
    const api: ApiFn = async (path, init) => {
      if (path === "/api/settings/llm" && init?.method === "PUT") {
        throw new ApiError(400, "“x-session-id” is managed by Knowlify.", "invalid_header");
      }
      return inner(path, init);
    };
    renderCard(api);
    fireEvent.change(await screen.findByLabelText("Model"), { target: { value: "deepseek-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("“x-session-id” is managed by Knowlify.")).toBeInTheDocument();
    expect(headersDetails().open).toBe(true);
    expect(screen.getByLabelText("Header 1 name")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText("Header 1 name")).toHaveFocus());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["name", "Header 1 name"],
    ["value", "Header 1 value"],
  ] as const)("focuses the %s input reported by the server on save", async (field, inputLabel) => {
    const inner = mock("headers");
    const message =
      field === "value"
        ? "The value of the header “x-session-id” is not valid"
        : "The header “x-session-id” cannot be set";
    const api: ApiFn = async (path, init) => {
      if (path === "/api/settings/llm" && init?.method === "PUT") {
        throw new ApiError(400, message, "invalid_header", { message, code: "invalid_header", field });
      }
      return inner(path, init);
    };
    renderCard(api);
    fireEvent.change(await screen.findByLabelText("Model"), { target: { value: "deepseek-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText(inputLabel)).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText(inputLabel)).toHaveFocus());
  });

  it("warns when saved header values cannot be read and asks for them again", async () => {
    const { api, calls } = spyApi(mock("headers-unreadable"));
    renderCard(api);
    expect(
      await screen.findByText("The saved custom header values can't be read. Open Custom headers, enter them again and save."),
    ).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Custom headers (1)")).toBeInTheDocument();
    expect(within(headersDetails()).queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "deepseek-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a value.")).toBeInTheDocument();
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  it("adds and removes rows and stops adding at the limit", async () => {
    renderCard(mock("headers"));
    await screen.findByText("Custom headers (1)");
    const details = openHeaders();
    for (let index = 0; index < 7; index += 1) {
      fireEvent.click(within(details).getByRole("button", { name: "Add header" }));
    }
    expect(within(details).getByRole("button", { name: "Add header" })).toBeDisabled();
    expect(screen.getByLabelText("Header 8 name")).toBeInTheDocument();

    fireEvent.click(within(details).getByRole("button", { name: "Remove header x-session-id" }));
    expect(within(details).getByRole("button", { name: "Add header" })).toBeEnabled();
    expect(screen.queryByLabelText("Header 8 name")).not.toBeInTheDocument();
  });

  it("sends headers with a probe only when the header draft changed", async () => {
    const { api, calls } = spyApi(mock("headers"));
    renderCard(api);
    await screen.findByText("Custom headers (1)");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected in 42 ms.")).toBeInTheDocument();
    const unchanged = calls.find((call) => call.path.endsWith("/test"));
    expect(bodyOf(unchanged!)).toEqual({});

    fireEvent.change(headerValue(), { target: { value: "probe-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(calls.filter((call) => call.path.endsWith("/test"))).toHaveLength(2));
    const changed = calls.filter((call) => call.path.endsWith("/test"))[1];
    expect(bodyOf(changed)).toEqual({ headers: [{ name: "x-session-id", value: "probe-value" }] });
  });

  it.each(["Test connection", "Fetch models"])(
    "blocks %s with an invalid header draft and focuses the first error",
    async (label) => {
      const { api, calls } = spyApi(mock("headers"));
      renderCard(api);
      await screen.findByText("Custom headers (1)");
      fireEvent.change(screen.getByLabelText("Header 1 name"), { target: { value: "Accept-Language" } });
      const before = calls.length;
      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(await screen.findByText("Fix the custom headers first.")).toBeInTheDocument();
      expect(screen.getByLabelText("Header 1 name")).toHaveAttribute("aria-invalid", "true");
      await waitFor(() => expect(screen.getByLabelText("Header 1 name")).toHaveFocus());
      expect(calls.length).toBe(before);
      expect(calls.some((call) => call.path.endsWith("/test") || call.path.endsWith("/models"))).toBe(false);
    },
  );

  it.each(["Test connection", "Fetch models"])(
    "maps a server header rejection from %s to the named row",
    async (label) => {
      const inner = mock("headers");
      const api: ApiFn = async (path, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if ((path.endsWith("/test") || path.endsWith("/models")) && method === "POST") {
          throw new ApiError(400, "“x-session-id” is managed by Knowlify.", "invalid_header");
        }
        return inner(path, init);
      };
      renderCard(api);
      await screen.findByText("Custom headers (1)");
      fireEvent.change(headerValue(), { target: { value: "probe-value" } });
      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(await screen.findByText("Fix the highlighted custom header and try again.")).toBeInTheDocument();
      expect(screen.getByText("“x-session-id” is managed by Knowlify.")).toBeInTheDocument();
      expect(screen.getByLabelText("Header 1 name")).toHaveAttribute("aria-invalid", "true");
      await waitFor(() => expect(screen.getByLabelText("Header 1 name")).toHaveFocus());
    },
  );

  it.each([
    ["Test connection", "value", "Header 1 value"],
    ["Fetch models", "value", "Header 1 value"],
    ["Test connection", "name", "Header 1 name"],
    ["Fetch models", "name", "Header 1 name"],
  ] as const)("maps the %s server rejection to the %s field reported by the server", async (label, field, inputLabel) => {
    const inner = mock("headers");
    const message =
      field === "value"
        ? "The value of the header “x-session-id” is not valid"
        : "The header “x-session-id” cannot be set";
    const api: ApiFn = async (path, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if ((path.endsWith("/test") || path.endsWith("/models")) && method === "POST") {
        throw new ApiError(400, message, "invalid_header", { message, code: "invalid_header", field });
      }
      return inner(path, init);
    };
    renderCard(api);
    await screen.findByText("Custom headers (1)");
    fireEvent.change(headerValue(), { target: { value: "probe-value" } });
    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(await screen.findByText("Fix the highlighted custom header and try again.")).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText(inputLabel)).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText(inputLabel)).toHaveFocus());
  });

  it("shows an inline error for an Accept* header", async () => {
    const { api, calls } = spyApi(mock("headers"));
    renderCard(api);
    await screen.findByText("Custom headers (1)");
    const details = openHeaders();
    fireEvent.click(within(details).getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByLabelText("Header 2 name"), { target: { value: "Accept-Language" } });
    fireEvent.change(screen.getByLabelText("Header 2 value"), { target: { value: "en" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("“Accept-Language” is managed by Knowlify.")).toBeInTheDocument();
    expect(screen.getByLabelText("Header 2 name")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText("Header 2 name")).toHaveFocus());
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });
});
