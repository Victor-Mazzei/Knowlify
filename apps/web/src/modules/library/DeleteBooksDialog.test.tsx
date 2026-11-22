import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BookSelection, DeleteDryRun, DeleteResult } from "../../types";
import { DeleteBooksDialog } from "./DeleteBooksDialog";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const report = (overrides: Partial<DeleteDryRun> = {}): DeleteDryRun => ({
  books: 2,
  notes: 1,
  conversations: 0,
  withProgress: 2,
  indexed: 1,
  managedFiles: 1,
  externalBooks: 1,
  wouldIgnore: 1,
  ...overrides,
});

const result = (overrides: Partial<DeleteResult> = {}): DeleteResult => ({
  removed: 2,
  missing: 0,
  notesRemoved: 1,
  ignored: 1,
  filesRemoved: 1,
  fileErrors: 0,
  remaining: 0,
  ...overrides,
});

function dryRunApi(data: DeleteDryRun = report()) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    expect(path).toBe("/api/books/delete");
    const body = JSON.parse(String(init?.body)) as { dryRun?: boolean };
    return body.dryRun ? json(data) : json(result({ removed: data.books }));
  });
}

describe("DeleteBooksDialog", () => {
  it("reviews the dry run, focuses Cancel and requires the notes confirmation", async () => {
    const api = dryRunApi();
    const onDeleted = vi.fn();
    render(<DeleteBooksDialog api={api} selection={{ ids: ["a", "b"] }} onDeleted={onDeleted} onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Delete 2 books?" })).toBeInTheDocument();
    expect(screen.getByText(/Files in your library folders are never touched/)).toBeInTheDocument();
    expect(screen.getByText(/I understand my notes will be permanently deleted/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Delete 2 books" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /I understand my notes/ }));
    const confirm = screen.getByRole("button", { name: "Delete 2 books" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(result(), { ids: ["a", "b"] }));
    const execute = api.mock.calls[api.mock.calls.length - 1];
    expect(JSON.parse(String(execute?.[1]?.body))).toEqual({
      selection: { ids: ["a", "b"] },
      confirmNotes: true,
      dryRun: false,
    });
  });

  it("requires typing delete for a filtered selection", async () => {
    const api = dryRunApi(report({ books: 12, notes: 0 }));
    render(
      <DeleteBooksDialog
        api={api}
        selection={{ filter: { format: "pdf" }, expectedTotal: 12 }}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Delete 12 books?" })).toBeInTheDocument();
    const input = screen.getByLabelText("Type delete to confirm");
    expect(screen.getByRole("button", { name: "Delete 12 books" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "delet" } });
    expect(screen.getByRole("button", { name: "Delete 12 books" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "delete" } });
    expect(screen.getByRole("button", { name: "Delete 12 books" })).toBeEnabled();
  });

  it("reviews the new total when the filter changes before the dry run", async () => {
    const api = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { selection: { expectedTotal: number }; dryRun?: boolean };
      if (!body.dryRun) return json(result({ removed: 7 }));
      if (body.selection.expectedTotal !== 7) {
        return json({ message: "Selection changed", code: "selection_changed", total: 7 }, 409);
      }
      return json(report({ books: 7, notes: 0 }));
    });
    render(
      <DeleteBooksDialog
        api={api}
        selection={{ filter: { read: "reading" }, expectedTotal: 5 }}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText(/The filter now matches 7 books/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Delete 7 books?" })).toBeInTheDocument();
    const reviewCall = api.mock.calls[api.mock.calls.length - 1];
    expect(JSON.parse(String(reviewCall?.[1]?.body)).selection).toEqual({
      filter: { read: "reading" },
      expectedTotal: 7,
    });
  });

  it("reports a partial deletion and re-confirms only the remainder", async () => {
    const onDeleted = vi.fn();
    const onPartial = vi.fn(() => {
      // A browser blurs the focused Cancel button when `busy` disables it. The
      // dialog must restore the focus once the deletion settles; jsdom keeps the
      // focus, so this makes the assertion independent of that behavior.
      (document.activeElement as HTMLElement | null)?.blur();
    });
    const requests: Array<{ selection: BookSelection; dryRun?: boolean; confirmNotes?: boolean }> = [];
    let executions = 0;
    const api = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        selection: BookSelection;
        dryRun?: boolean;
        confirmNotes?: boolean;
      };
      requests.push(body);
      if (body.dryRun) {
        const books = "ids" in body.selection ? body.selection.ids.length : body.selection.expectedTotal;
        return json(report({ books, notes: books === 2 ? 1 : 0 }));
      }
      executions += 1;
      if (executions === 1) {
        return json(
          {
            message: "Some books changed",
            code: "selection_changed",
            removed: 1,
            remainingIds: ["b", "c"],
          },
          409,
        );
      }
      return json(result({ removed: 2, notesRemoved: 1 }));
    });
    render(
      <DeleteBooksDialog
        api={api}
        selection={{ ids: ["a", "b", "c"] }}
        onDeleted={onDeleted}
        onPartial={onPartial}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Delete 3 books" }));
    expect(
      await screen.findByText("Deleted 1 of 3. 2 books changed (new notes) and were not deleted — review again."),
    ).toBeInTheDocument();
    expect(onPartial).toHaveBeenCalledWith({ removedIds: ["a"], remaining: { ids: ["b", "c"] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());

    // The automatic review exposes the new note and asks for a fresh confirmation.
    expect(await screen.findByRole("heading", { name: "Delete 2 books?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete 2 books" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand my notes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 books" }));

    await waitFor(() =>
      expect(onDeleted).toHaveBeenCalledWith(result({ removed: 3, notesRemoved: 1 }), { ids: ["b", "c"] }),
    );
    const executes = requests.filter((request) => request.dryRun === false);
    expect(executes.map((request) => request.selection)).toEqual([
      { ids: ["a", "b", "c"] },
      { ids: ["b", "c"] },
    ]);
  });

  it("reviews a filtered remainder with its new total", async () => {
    const onDeleted = vi.fn();
    const onPartial = vi.fn();
    const requests: Array<{ selection: BookSelection; dryRun?: boolean }> = [];
    let executions = 0;
    const api = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { selection: BookSelection; dryRun?: boolean };
      requests.push(body);
      if (body.dryRun) {
        const books = "ids" in body.selection ? body.selection.ids.length : body.selection.expectedTotal;
        return json(report({ books, notes: 0 }));
      }
      executions += 1;
      if (executions === 1) {
        return json(
          { message: "Some books changed", code: "selection_changed", removed: 2, remainingTotal: 3 },
          409,
        );
      }
      return json(result({ removed: 3 }));
    });
    render(
      <DeleteBooksDialog
        api={api}
        selection={{ filter: { read: "reading" }, expectedTotal: 5 }}
        onDeleted={onDeleted}
        onPartial={onPartial}
        onClose={vi.fn()}
      />,
    );

    const confirm = await screen.findByRole("button", { name: "Delete 5 books" });
    fireEvent.change(screen.getByLabelText("Type delete to confirm"), { target: { value: "delete" } });
    fireEvent.click(confirm);
    expect(
      await screen.findByText("Deleted 2 of 5. 3 books changed (new notes) and were not deleted — review again."),
    ).toBeInTheDocument();
    expect(onPartial).toHaveBeenCalledWith({
      removedIds: undefined,
      remaining: { filter: { read: "reading" }, expectedTotal: 3 },
    });

    expect(await screen.findByRole("heading", { name: "Delete 3 books?" })).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Delete 3 books" });
    expect(retry).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type delete to confirm"), { target: { value: "delete" } });
    fireEvent.click(retry);

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(result({ removed: 5 }), {
      filter: { read: "reading" },
      expectedTotal: 3,
    }));
    expect(requests.filter((request) => request.dryRun === false).map((request) => request.selection)).toEqual([
      { filter: { read: "reading" }, expectedTotal: 5 },
      { filter: { read: "reading" }, expectedTotal: 3 },
    ]);
  });

  it("reviews again when a note appears between the dry run and the deletion", async () => {
    const onDeleted = vi.fn();
    const requests: Array<{ selection: BookSelection; dryRun?: boolean; confirmNotes?: boolean }> = [];
    let dryRuns = 0;
    let executions = 0;
    const api = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        selection: BookSelection;
        dryRun?: boolean;
        confirmNotes?: boolean;
      };
      requests.push(body);
      if (body.dryRun) {
        dryRuns += 1;
        return json(report({ books: 2, notes: dryRuns === 1 ? 0 : 1 }));
      }
      executions += 1;
      if (executions === 1) {
        return json({ message: "Some selected books have notes", code: "notes_confirmation_required" }, 409);
      }
      return json(result());
    });
    render(<DeleteBooksDialog api={api} selection={{ ids: ["a", "b"] }} onDeleted={onDeleted} onClose={vi.fn()} />);

    const confirm = await screen.findByRole("button", { name: "Delete 2 books" });
    expect(screen.queryByRole("checkbox", { name: /I understand my notes/ })).toBeNull();
    fireEvent.click(confirm);

    expect(
      await screen.findByText("Some selected books now have notes. Review the updated impact and confirm again."),
    ).toBeInTheDocument();
    const checkbox = await screen.findByRole("checkbox", { name: /I understand my notes/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Delete 2 books" })).toBeDisabled();
    expect(dryRuns).toBe(2);

    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 books" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(result(), { ids: ["a", "b"] }));
    const retry = requests.filter((request) => request.dryRun === false)[1];
    expect(retry).toEqual({ selection: { ids: ["a", "b"] }, confirmNotes: true, dryRun: false });
  });

  it("closes on Escape without deleting", async () => {
    const api = dryRunApi(report({ books: 1, notes: 0 }));
    const onClose = vi.fn();
    render(<DeleteBooksDialog api={api} selection={{ ids: ["a"] }} onDeleted={vi.fn()} onClose={onClose} />);
    await screen.findByRole("heading", { name: "Delete 1 book?" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores Escape and backdrop clicks while the deletion is in flight", async () => {
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    let resolveDelete: ((response: Response) => void) | undefined;
    const api = vi.fn((_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { dryRun?: boolean };
      if (body.dryRun) return Promise.resolve(json(report({ books: 2, notes: 0 })));
      return new Promise<Response>((resolve) => {
        resolveDelete = resolve;
      });
    });
    render(<DeleteBooksDialog api={api} selection={{ ids: ["a", "b"] }} onDeleted={onDeleted} onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete 2 books" }));
    expect(await screen.findByRole("button", { name: "Deleting…" })).toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });
    const backdrop = document.querySelector(".dialog-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    expect(onClose).not.toHaveBeenCalled();

    resolveDelete?.(json(result()));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete 2 books" })).toBeEnabled());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a failed review with a retry", async () => {
    const api = vi.fn(async () => json({ message: "offline" }, 500));
    render(<DeleteBooksDialog api={api} selection={{ ids: ["a"] }} onDeleted={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
