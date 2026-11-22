import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { mockBooksApi } from "../library/mockBooksApi";
import { TagsCard } from "./TagsCard";

const renderCard = (api = mockBooksApi([])) =>
  render(
    <MemoryRouter>
      <TagsCard api={api} />
    </MemoryRouter>,
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("TagsCard", () => {
  it("lists tags, creates one with a palette color and shows the count", async () => {
    const base = mockBooksApi([]);
    const api = vi.fn(base);
    renderCard(api);

    expect(await screen.findByText("Favorites")).toBeInTheDocument();
    expect(screen.getByText("Read later")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Deep   work " } });
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    fireEvent.click(screen.getByRole("button", { name: "Create tag" }));

    expect(await screen.findByText("Deep work")).toBeInTheDocument();
    expect(screen.getByText("Tag created.")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("keeps a duplicate name inline instead of replacing the row", async () => {
    const base = mockBooksApi([]);
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/tags/tag-favorites" && init?.method === "PATCH") {
        return json({ message: "Tag name already exists", code: "tag_name_taken" }, 409);
      }
      return base(path, init);
    });
    renderCard(api);

    const row = (await screen.findByText("Favorites")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Rename" }));
    const input = within(row).getByRole("textbox", { name: "Rename Favorites" });
    fireEvent.change(input, { target: { value: "Research" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await within(row).findByRole("alert")).toHaveTextContent("A tag with this name already exists.");
    expect(within(row).getByRole("textbox")).toBeInTheDocument();
  });

  it("recolors a tag from the nine-swatch radiogroup", async () => {
    const base = mockBooksApi([]);
    const api = vi.fn(base);
    renderCard(api);

    const row = (await screen.findByText("Favorites")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Color" }));
    fireEvent.click(within(row).getByRole("radio", { name: "Pink" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/tags/tag-favorites",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ color: "pink" }) }),
      ),
    );
  });

  it("asks before deleting a tag and never deletes books", async () => {
    const api = vi.fn(mockBooksApi([]));
    renderCard(api);

    const row = (await screen.findByText("Research")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete the tag “Research”?")).toBeInTheDocument();
    expect(screen.getByText(/Books are not deleted\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete tag" }));

    await waitFor(() => expect(screen.queryByText("Research")).not.toBeInTheDocument());
    expect(await screen.findByText("Tag removed from every book.")).toBeInTheDocument();
  });

  it("hides the card on a server without the tags contract", async () => {
    const api = vi.fn(async () => json({ message: "Not found" }, 404));
    const { container } = renderCard(api);
    // The card renders its loading state until the 404 marks tags unavailable.
    await waitFor(() => expect(container.querySelector("#tags")).toBeNull());
    expect(api).toHaveBeenCalledWith("/api/tags", expect.anything());
  });
});
