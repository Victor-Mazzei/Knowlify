import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Book, TagWithCount } from "../../types";
import { TagPopover } from "./TagPopover";

const book = (id: string, tagIds: string[] = []): Book => ({
  id,
  title: `Book ${id}`,
  author: "",
  format: "epub",
  size: 1,
  addedAt: 0,
  hasCover: false,
  status: "ready",
  source: false,
  tagIds,
});

const tags: TagWithCount[] = [
  { id: "t1", name: "Favorites", color: "blue", createdAt: 0, count: 4 },
  { id: "t2", name: "Research", color: "amber", createdAt: 0, count: 2 },
];

function setup(overrides: Partial<Parameters<typeof TagPopover>[0]> = {}) {
  const props = {
    tags,
    loading: false,
    selectedBooks: [book("a", ["t1"]), book("b")],
    allMode: false,
    onApply: vi.fn(async () => undefined),
    onCreate: vi.fn(async (name: string) => ({
      id: "t3",
      name,
      color: "gray" as const,
      createdAt: 0,
    })),
    onClose: vi.fn(),
    ...overrides,
  };
  render(
    <MemoryRouter>
      <TagPopover {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("TagPopover", () => {
  it("renders the tri-state from the loaded selected books", () => {
    setup();
    expect(screen.getByRole("checkbox", { name: /Favorites: applied to some/ })).toBePartiallyChecked();
    expect(screen.getByRole("checkbox", { name: /Research: not applied/ })).not.toBeChecked();
  });

  it("adds a tag through the tri-state checkbox", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: /Research/ }));
    expect(props.onApply).toHaveBeenLastCalledWith(["t2"], []);
  });

  it("removes a tag applied to every selected book", () => {
    const props = setup({ selectedBooks: [book("a", ["t1"]), book("b", ["t1"])] });
    fireEvent.click(screen.getByRole("checkbox", { name: /Favorites/ }));
    expect(props.onApply).toHaveBeenLastCalledWith([], ["t1"]);
  });

  it("offers explicit Add and Remove in all-results mode", async () => {
    const props = setup({ allMode: true });
    expect(screen.queryByRole("checkbox", { name: /Favorites/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    expect(props.onApply).toHaveBeenLastCalledWith(["t1"], []);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove" })[0]).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(props.onApply).toHaveBeenLastCalledWith([], ["t1"]);
  });

  it("creates a tag from the search term and applies it", async () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText("Search or create a tag"), { target: { value: "Deep work" } });
    fireEvent.click(screen.getByRole("button", { name: "Create tag “Deep work”" }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith("Deep work"));
    expect(props.onApply).toHaveBeenLastCalledWith(["t3"], []);
  });

  it("links to the manager and closes on Escape", () => {
    const props = setup();
    expect(screen.getByRole("link", { name: "Manage tags" })).toHaveAttribute("href", "/settings/tags");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("keeps a failed mutation visible inside the panel", async () => {
    setup({
      onApply: vi.fn(async () => {
        throw Object.assign(new Error("conflict"), { code: "book_tag_limit" });
      }),
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Research/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A book cannot have more than 50 tags.");
  });
});
