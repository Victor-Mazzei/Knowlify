import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { MetadataCard } from "./MetadataCard";
import { createMockMetadataApi, type MockMetadataScenario } from "./metadataSettingsMock";

type Call = { path: string; init?: RequestInit };

const mock = (scenario: MockMetadataScenario) => createMockMetadataApi({ scenario });

const spyApi = (inner: ApiFn) => {
  const calls: Call[] = [];
  const api: ApiFn = (path, init) => {
    calls.push({ path, init });
    return inner(path, init);
  };
  return { api, calls };
};

const toggle = () => screen.getByRole("switch", { name: "Enable online metadata lookup" });
const keyInput = () => screen.getByLabelText("Google Books API key");
const saveButton = () => screen.getByRole("button", { name: /Save changes|Saving…/ });

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__KNOWLIFY__;
});

describe("MetadataCard", () => {
  it("shows a skeleton, then the providers, the toggle and the privacy notice", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = mock("default");
    render(
      <MetadataCard
        api={async (path, init) => {
          await gate;
          return inner(path, init);
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading metadata settings…");
    await act(async () => release());

    expect(await screen.findByText("Open Library")).toBeInTheDocument();
    expect(screen.getByText("Always on")).toBeInTheDocument();
    expect(screen.getByText("Google Books")).toBeInTheDocument();
    expect(screen.getByText("No key")).toBeInTheDocument();
    expect(toggle()).toBeChecked();
    expect(keyInput()).toHaveAttribute("type", "password");
    expect(
      screen.getByText(/Title, author and ISBN are sent to Open Library and, only if it fails or finds nothing, to Google Books/),
    ).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("saves the toggle and a new key without ever rendering the key again", async () => {
    const { api, calls } = spyApi(mock("default"));
    render(<MetadataCard api={api} />);
    await screen.findByRole("switch", { name: "Enable online metadata lookup" });

    fireEvent.click(toggle());
    fireEvent.change(keyInput(), { target: { value: "AIzaSyMockKey_123" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(keyInput()).toHaveAttribute("type", "text");
    expect(keyInput()).toHaveValue("AIzaSyMockKey_123");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(keyInput()).toHaveAttribute("type", "password");

    fireEvent.click(saveButton());
    expect(await screen.findByText("Saved.")).toBeInTheDocument();

    const put = calls.find((call) => call.init?.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      lookupEnabled: false,
      googleBooksKey: "AIzaSyMockKey_123",
    });
    expect(keyInput()).toHaveValue("");
    expect(keyInput()).toHaveAttribute("placeholder", "Leave blank to keep the saved key");
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("AIzaSyMockKey_123")).not.toBeInTheDocument();
    expect(toggle()).not.toBeChecked();
    expect(screen.getByText("Off", { selector: ".meta-state" })).toBeInTheDocument();
  });

  it("keeps the saved key when the field is left blank and the toggle changes", async () => {
    const { api, calls } = spyApi(mock("saved"));
    render(<MetadataCard api={api} />);
    await screen.findByText("Your key");

    expect(keyInput()).toHaveValue("");
    expect(keyInput()).toHaveAttribute("placeholder", "Leave blank to keep the saved key");
    fireEvent.click(toggle());
    fireEvent.click(saveButton());
    expect(await screen.findByText("Saved.")).toBeInTheDocument();

    const put = calls.find((call) => call.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body))).toEqual({ lookupEnabled: false });
  });

  it("shows the server key and lets a saved key override it", async () => {
    const { api, calls } = spyApi(mock("env-key"));
    render(<MetadataCard api={api} />);
    await screen.findByText("Server key");

    expect(screen.getByText(/Using the server key \(environment\)\. Saving a key here overrides it\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
    expect(keyInput()).toHaveAttribute("placeholder", "Paste a key to override the server key");

    fireEvent.change(keyInput(), { target: { value: "my-own-key" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    const put = calls.find((call) => call.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body))).toEqual({ googleBooksKey: "my-own-key" });
    expect(screen.queryByText(/Using the server key/)).not.toBeInTheDocument();
    expect(screen.getByText("Your key")).toBeInTheDocument();
  });

  it("removes a saved key after confirmation", async () => {
    const { api, calls } = spyApi(mock("saved"));
    render(<MetadataCard api={api} />);
    await screen.findByText("Your key");

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    const confirm = screen.getByRole("alertdialog", { name: "Remove the saved Google Books key?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove key" }));

    expect(await screen.findByText("Saved key removed.")).toBeInTheDocument();
    const puts = calls.filter((call) => call.init?.method === "PUT");
    const put = puts[puts.length - 1];
    expect(JSON.parse(String(put?.init?.body))).toEqual({ googleBooksKey: null });
    expect(screen.queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
    expect(screen.getByText("No key")).toBeInTheDocument();
  });

  it("is read-only when the server locks the settings", async () => {
    render(<MetadataCard api={mock("locked")} />);
    await screen.findByText("Server key");

    expect(screen.getByText("Managed by server")).toBeInTheDocument();
    expect(toggle()).toBeDisabled();
    expect(keyInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show" })).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/Managed by the server environment/)).toBeInTheDocument();
  });

  it("asks for the key again when the saved one cannot be read", async () => {
    const { api } = spyApi(mock("unreadable"));
    render(<MetadataCard api={api} />);
    await screen.findByText("Key unreadable");

    expect(screen.getByRole("alert")).toHaveTextContent("The saved Google Books key can't be read. Enter it again and save.");
    expect(keyInput()).toHaveAttribute("placeholder", "Enter the key again");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("keeps only the informative text when the server predates the route", async () => {
    render(<MetadataCard api={mock("unavailable")} />);
    expect(await screen.findByText(/This server does not expose the lookup settings/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Google Books API key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save changes/ })).not.toBeInTheDocument();
  });

  it("rejects keys with spaces before sending them", async () => {
    const { api, calls } = spyApi(mock("default"));
    render(<MetadataCard api={api} />);
    await screen.findByRole("switch", { name: "Enable online metadata lookup" });

    fireEvent.change(keyInput(), { target: { value: "bad key" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/printable ASCII characters, without spaces/)).toBeInTheDocument();
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  it("shows a locked error from the server inline", async () => {
    const base = mock("default");
    const api: ApiFn = async (path, init) => {
      if (init?.method === "PUT") throw new ApiError(403, "Metadata settings are locked by the server operator.");
      return base(path, init);
    };
    render(<MetadataCard api={api} />);
    await screen.findByRole("switch", { name: "Enable online metadata lookup" });

    fireEvent.click(toggle());
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Metadata settings are locked by the server operator."),
    );
  });
});
