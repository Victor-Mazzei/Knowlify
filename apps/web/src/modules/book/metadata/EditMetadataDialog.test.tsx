import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../../components/dialogs";
import { sampleBookDetail, noOverrides } from "./mockMetadataBook";
import { createMockMetadataApi } from "./mockMetadataApi";
import { EditMetadataDialog } from "./EditMetadataDialog";

type Call = { path: string; init?: RequestInit };

const spyApi = (inner: ApiFn) => {
  const calls: Call[] = [];
  const api: ApiFn = (path, init) => {
    calls.push({ path, init });
    return inner(path, init);
  };
  return { api, calls };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const bodyOf = (call: Call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>;

describe("EditMetadataDialog", () => {
  it("prefills the effective values, labels their origin and focuses the title", () => {
    const book = sampleBookDetail();
    render(
      <EditMetadataDialog book={book} api={createMockMetadataApi()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: "Edit metadata" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("The Quiet Library");
    expect(screen.getByLabelText("Title")).toHaveFocus();
    expect(screen.getAllByText("From file").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Not set").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("saves only the changed fields and reports the new detail", async () => {
    const { api, calls } = spyApi(createMockMetadataApi());
    const onSaved = vi.fn();
    render(<EditMetadataDialog book={sampleBookDetail()} api={api} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "A new title" } });
    fireEvent.change(screen.getByLabelText("Publisher"), { target: { value: "West Press" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Metadata saved.")).toBeInTheDocument();
    const patch = calls.find((call) => call.path.endsWith("/metadata") && call.init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(bodyOf(patch!)).toEqual({ title: "A new title", publisher: "West Press", source: "manual" });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ title: "A new title" }));
  });

  it("keeps an invalid checksum in the dialog", async () => {
    const { api, calls } = spyApi(createMockMetadataApi());
    render(<EditMetadataDialog book={sampleBookDetail()} api={api} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("ISBN-13"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/ISBN-13 must have 13 digits/)).toBeInTheDocument();
    expect(screen.getByText("Check the highlighted fields.")).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith("/metadata"))).toBe(false);
  });

  it("resets one overridden field to the file value", async () => {
    const book = sampleBookDetail(
      {},
      { publisher: "Old Press", overridden: { ...noOverrides(), publisher: true } },
    );
    const { api, calls } = spyApi(createMockMetadataApi());
    render(<EditMetadataDialog book={book} api={api} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset Publisher to file" }));
    expect(screen.getByLabelText("Publisher")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(calls.some((call) => call.path.endsWith("/metadata") && call.init?.method === "PATCH")).toBe(true),
    );
    const patch = calls.find((call) => call.path.endsWith("/metadata") && call.init?.method === "PATCH");
    expect(bodyOf(patch!)).toEqual({ publisher: null });
  });

  it("resets everything after confirmation", async () => {
    const book = sampleBookDetail(
      {},
      { title: "Edited", overridden: { ...noOverrides(), title: true }, file: { title: "File title", author: "Ada North" } },
    );
    const seed = { ...book, title: "File title", author: "Ada North" };
    const { api, calls } = spyApi(createMockMetadataApi({ books: [seed] }));
    const onSaved = vi.fn();
    render(<EditMetadataDialog book={book} api={api} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to file metadata" }));
    expect(screen.getByRole("alertdialog", { name: "Reset to file metadata?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset metadata" }));

    await waitFor(() =>
      expect(calls).toContainEqual({ path: "/api/books/meta-1/metadata", init: { method: "DELETE" } }),
    );
    expect(await screen.findByText("Metadata reset to the file.")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("File title");
    expect(onSaved).toHaveBeenCalled();
  });

  it("uploads a custom cover and shows its state", async () => {
    const { api, calls } = spyApi(createMockMetadataApi());
    const onSaved = vi.fn();
    render(<EditMetadataDialog book={sampleBookDetail()} api={api} onClose={vi.fn()} onSaved={onSaved} />);

    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Upload cover image"), { target: { files: [file] } });

    expect(await screen.findByText("Custom cover")).toBeInTheDocument();
    const upload = calls.find((call) => call.init?.method === "PUT");
    expect(upload?.path).toBe("/api/books/meta-1/cover");
    expect((upload?.init?.body as FormData).get("file")).toBe(file);
    expect(onSaved).toHaveBeenCalled();
  });

  it("removes a custom cover only after confirmation", async () => {
    const book = sampleBookDetail(
      { coverRev: 3 },
      { overridden: { ...noOverrides(), cover: true } },
    );
    const { api, calls } = spyApi(createMockMetadataApi({ books: [book] }));
    render(<EditMetadataDialog book={book} api={api} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove custom cover" }));
    expect(screen.getByRole("alertdialog", { name: "Remove custom cover?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove cover" }));

    await waitFor(() =>
      expect(calls).toContainEqual({ path: "/api/books/meta-1/cover", init: { method: "DELETE" } }),
    );
    expect(await screen.findByText("From file", { selector: ".metadata-cover-state" })).toBeInTheDocument();
  });

  it("maps a server field error to the input", async () => {
    const inner = createMockMetadataApi();
    const failing: ApiFn = async (path, init) =>
      path.endsWith("/metadata") && init?.method === "PATCH"
        ? json({ message: "Author is not allowed.", field: "author" }, 400)
        : inner(path, init);
    const { api, calls } = spyApi(failing);
    render(<EditMetadataDialog book={sampleBookDetail()} api={api} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "Someone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Author is not allowed.")).toBeInTheDocument();
    expect(screen.getByLabelText("Author")).toHaveAttribute("aria-invalid", "true");
    expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true);
  });
});
