import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { unavailableEmbedderStatus, idleIndexStatus, indexStatus, pausedIndexStatus, runningIndexStatus } from "./fixtures";
import { IndexStatusContext } from "./IndexStatusContext";
import { SearchIndexCard } from "./SearchIndexCard";
import type { IndexStatusState } from "./useIndexStatus";

function renderCard(
  status: IndexStatusState["status"],
  available = true,
  options: { pause?: unknown; pauseError?: boolean } = {},
) {
  const refresh = vi.fn(async () => status);
  const api = vi.fn(async (path: string) => {
    if (path.endsWith("/index/pause") || path.endsWith("/index/resume")) {
      if (options.pauseError) throw new Error("offline");
      return new Response(JSON.stringify(options.pause ?? { paused: true }));
    }
    return new Response(JSON.stringify({ queued: 3 }));
  });
  const view = render(
    <IndexStatusContext.Provider value={{ status, available, refresh }}>
      <SearchIndexCard api={api} />
    </IndexStatusContext.Provider>,
  );
  return { api, refresh, view };
}

describe("SearchIndexCard", () => {
  it("stays hidden when the server has no knowledge API", () => {
    const { view } = renderCard(null, false);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("explains when search indexing is disabled", () => {
    renderCard(indexStatus({ enabled: false }));
    expect(screen.getByText("Search indexing is turned off on the server. Books are still readable.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reindex all" })).not.toBeInTheDocument();
  });

  it("shows counts and the lexical fallback in plain language", () => {
    renderCard(unavailableEmbedderStatus);
    expect(screen.getByText("Searchable").nextElementSibling).toHaveTextContent("12");
    expect(screen.getByText("Failed").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Semantic search is unavailable right now. Word search still works.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();
  });

  it("asks for confirmation before reindexing every book", async () => {
    const { api, refresh } = renderCard(idleIndexStatus);
    fireEvent.click(screen.getByRole("button", { name: "Reindex all" }));

    const dialog = screen.getByRole("alertdialog", { name: "Reindex every book?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reindex all" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/index/reindex",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ scope: "all" }) }),
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText("3 books queued.")).toBeInTheDocument();
  });

  it("retries failed books without a confirmation", async () => {
    const { api } = renderCard(unavailableEmbedderStatus);
    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/index/reindex",
        expect.objectContaining({ body: JSON.stringify({ scope: "failed" }) }),
      ),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows rate, ETA, workers and the vector policy", () => {
    renderCard(runningIndexStatus);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("3 workers")).toBeInTheDocument();
    expect(screen.getByText("1,440 passages/min")).toBeInTheDocument();
    expect(screen.getByText("about 3 h left")).toBeInTheDocument();
    expect(screen.getByText(/First 1,000 books; others on demand/)).toBeInTheDocument();
    expect(screen.getByText(/use Index on a book to add them/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause indexing" })).toBeInTheDocument();
  });

  it("pauses optimistically and offers resume", async () => {
    const { api, refresh } = renderCard(runningIndexStatus);
    fireEvent.click(screen.getByRole("button", { name: "Pause indexing" }));

    expect(await screen.findByRole("button", { name: "Resume indexing" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Paused")).toBeInTheDocument();
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/index/pause", { method: "POST" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("rolls back a failed pause with a visible error", async () => {
    renderCard(runningIndexStatus, true, { pauseError: true });
    fireEvent.click(screen.getByRole("button", { name: "Pause indexing" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Pause indexing" })).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("offline");
  });

  it("shows resume for a paused queue even without pending work", () => {
    renderCard(indexStatus({ paused: true, counts: { pending: 0, indexing: 0, ready: 4, error: 0 }, workers: 2 }));
    expect(screen.getByRole("button", { name: "Resume indexing" })).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("2 workers")).toBeInTheDocument();
  });

  it("hides stale rate and ETA while paused", () => {
    renderCard(pausedIndexStatus);
    expect(screen.getByRole("button", { name: "Resume indexing" })).toBeInTheDocument();
    expect(screen.queryByText(/passages\/min/)).not.toBeInTheDocument();
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });

  it("hides the new controls when the server predates them", () => {
    renderCard(idleIndexStatus);
    expect(screen.queryByRole("button", { name: /indexing/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    expect(screen.queryByText(/Vectors:/)).not.toBeInTheDocument();
  });
});
