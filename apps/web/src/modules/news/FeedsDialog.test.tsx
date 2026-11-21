import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedsDialog } from "./FeedsDialog";

afterEach(() => vi.unstubAllGlobals());

describe("FeedsDialog", () => {
  it("shows an API error when a URL is rejected", async () => {
    render(
      <FeedsDialog
        feeds={[]}
        onAdd={vi.fn().mockRejectedValue(new Error("URL refused by server"))}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("https://example.com/feed.xml"), {
      target: { value: "http://localhost/feed.xml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add feed" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("URL refused by server");
    });
  });
});
