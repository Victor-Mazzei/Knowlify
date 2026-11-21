import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { ConfirmDialog, FolderPicker, useConfirm, useDialogKeys } from "./dialogs";
import type { FolderListing } from "../modules/folders/types";

function ConfirmHarness() {
  const { ask, dialog } = useConfirm();
  return <><button onClick={() => void ask({ title: "Confirm action", message: "Proceed?" })}>Open</button>{dialog}</>;
}

describe("dialogs", () => {
  it("opens, cancels on Escape, and resolves true on confirm", async () => {
    render(<ConfirmHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    render(<ConfirmDialog options={{ title: "Confirm", message: "Yes?" }} onResult={(value) => expect(value).toBe(true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  });

  it("renders folder breadcrumbs and navigates", async () => {
    const api = vi.fn(async (path: string) => new Response(JSON.stringify({
      path: path ? "/books" : "/",
      parent: path ? "/" : null,
      entries: [],
      books: 1,
    })));
    render(<FolderPicker api={api} onSelect={vi.fn()} onClose={vi.fn()} initialPath="/books" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "books" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "/" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "/" }));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("/api/fs?path=%2F"));
  });
});

describe("FolderPicker", () => {
  const roots: FolderListing = {
    path: "",
    parent: null,
    entries: [{ name: "library", path: "/library" }],
    books: 0,
    restricted: true,
  };

  function fsApi(listings: Record<string, FolderListing>) {
    return vi.fn(async (path: string) => new Response(JSON.stringify(listings[path.replace("/api/fs", "")])));
  }

  it("shows the allowed roots and explains a restricted server", async () => {
    const onClose = vi.fn();
    render(<FolderPicker api={fsApi({ "": roots })} onSelect={vi.fn()} onClose={onClose} />);
    expect(await screen.findByRole("heading", { name: "Choose an allowed folder" })).toBeInTheDocument();
    expect(screen.getByText(/Only folders mounted into the Knowlify container/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select this folder" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("explains an empty restricted folder and still allows selecting it", async () => {
    const api = fsApi({
      "": roots,
      "?path=%2Flibrary": { path: "/library", parent: "", entries: [], books: 0, restricted: true },
    });
    render(<FolderPicker api={api} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "library" }));
    expect(await screen.findByText(/No folders inside this one/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select this folder" })).toBeEnabled();
  });

  it("adds the current folder and keeps the reason when adding fails", async () => {
    const api = vi.fn(async () => new Response(JSON.stringify({ path: "/library", parent: null, entries: [], books: 0 })));
    const onSelect = vi.fn(async () => {
      throw new Error("This folder is outside the folders Knowlify may browse");
    });
    render(<FolderPicker api={api} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Select this folder" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("/library"));
    expect(await screen.findByRole("alert")).toHaveTextContent("outside the folders");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("retries a failed listing", async () => {
    let fail = true;
    const api = vi.fn(async () => {
      if (fail) throw new Error("Could not list folders.");
      return new Response(JSON.stringify({ path: "/library", parent: null, entries: [], books: 1 }));
    });
    render(<FolderPicker api={api} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not list folders.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Select this folder" })).toBeEnabled());
  });

  it("ignores a stale listing when responses arrive out of order", async () => {
    const pending: Array<{ path: string; resolve: (response: Response) => void }> = [];
    const api = vi.fn(
      (path: string) =>
        new Promise<Response>((resolve) => {
          pending.push({ path, resolve });
        }),
    );
    render(<FolderPicker api={api} initialPath="/a" onSelect={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(pending).toHaveLength(1));

    await act(async () => {
      pending[0]!.resolve(
        new Response(JSON.stringify({ path: "/a", parent: "/", entries: [{ name: "b", path: "/a/b" }], books: 1 })),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    await waitFor(() => expect(pending).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "/" }));
    await waitFor(() => expect(pending).toHaveLength(3));

    await act(async () => {
      pending[2]!.resolve(new Response(JSON.stringify({ path: "/", parent: null, entries: [], books: 0 })));
    });
    expect(await screen.findByText("0 books directly in this folder")).toBeInTheDocument();

    await act(async () => {
      pending[1]!.resolve(new Response(JSON.stringify({ path: "/a/b", parent: "/a", entries: [], books: 3 })));
    });
    expect(screen.getByText("0 books directly in this folder")).toBeInTheDocument();
    expect(screen.queryByText("3 books directly in this folder")).not.toBeInTheDocument();
  });
});

describe("nested dialogs", () => {
  function Nested({ onParent, onChild }: { onParent: () => void; onChild: () => void }) {
    const parent = useRef<HTMLDivElement>(null);
    const child = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    useDialogKeys(parent, onParent);
    return (
      <div ref={parent}>
        <button onClick={() => setOpen(true)}>open child</button>
        {open && <Child innerRef={child} onClose={() => { onChild(); setOpen(false); }} />}
      </div>
    );
  }
  function Child({ innerRef, onClose }: { innerRef: React.RefObject<HTMLDivElement>; onClose: () => void }) {
    useDialogKeys(innerRef, onClose);
    return <div ref={innerRef} />;
  }

  it("lets only the topmost dialog handle Escape, then the one below", () => {
    const onParent = vi.fn();
    const onChild = vi.fn();
    render(<Nested onParent={onParent} onChild={onChild} />);
    fireEvent.click(screen.getByText("open child"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onChild).toHaveBeenCalledTimes(1);
    expect(onParent).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onParent).toHaveBeenCalledTimes(1);
  });
});
