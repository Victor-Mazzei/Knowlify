import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ScanStatus } from "../../types";
import { busyIndexStatus, idleIndexStatus, indexStatus, pausedIndexStatus, runningIndexStatus } from "./fixtures";
import { IndexChip } from "./IndexChip";

type ScanOptions = Partial<ScanStatus> & { skippedDuplicates?: number };

const scan = (overrides: ScanOptions = {}): ScanStatus => ({
  scanning: false,
  pending: 0,
  lastScanAt: null,
  ...overrides,
});

const body = (value: unknown) => new Response(JSON.stringify(value));

function renderChip(index = idleIndexStatus, scanStatus = scan(), api = vi.fn(async () => body({ paused: true }))) {
  const refresh = vi.fn(async () => index);
  const view = render(
    <IndexChip scanStatus={scanStatus} index={index} scanError={false} api={api} refresh={refresh} />,
  );
  return { api, refresh, view };
}

describe("IndexChip", () => {
  it("stays silent when everything is idle", () => {
    renderChip();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports search indexing progress with a live region", () => {
    renderChip(busyIndexStatus);
    const chip = screen.getByRole("status");
    expect(chip).toHaveTextContent("Indexing for search 2 of 9");
    expect(chip).toHaveAttribute("aria-live", "polite");
    expect(chip).toHaveAttribute(
      "title",
      "6 queued · 1 in progress · 2 searchable · 0 failed · 42% of the current book",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the ETA, rate and workers from the runtime fields", () => {
    renderChip(runningIndexStatus);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing for search 2 of 11 · about 3 h left");
    expect(screen.getByRole("status")).toHaveAttribute(
      "title",
      "8 queued · 1 in progress · 2 searchable · 0 failed · 42% of the current book · 3 workers · 1,440 passages/min · about 3 h left",
    );
    expect(screen.getByRole("button", { name: "Pause search indexing" })).toBeInTheDocument();
  });

  it("pauses optimistically and switches the control to resume", async () => {
    const { api, refresh } = renderChip(runningIndexStatus);
    fireEvent.click(screen.getByRole("button", { name: "Pause search indexing" }));

    expect(screen.getByRole("status")).toHaveTextContent("Indexing paused");
    expect(screen.getByRole("button", { name: "Resume search indexing" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/index/pause", { method: "POST" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("rolls back a failed pause and keeps the error available", async () => {
    const api = vi.fn(async () => {
      throw new Error("offline");
    });
    renderChip(runningIndexStatus, scan(), api);
    fireEvent.click(screen.getByRole("button", { name: "Pause search indexing" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Indexing for search 2 of 11"));
    expect(screen.getByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("button", { name: "Pause search indexing" })).toBeInTheDocument();
  });

  it("keeps a paused queue visible even when there is no work left", () => {
    renderChip(indexStatus({ paused: true, counts: { pending: 0, indexing: 0, ready: 4, error: 0 }, workers: 2 }));
    expect(screen.getByRole("status")).toHaveTextContent("Indexing paused");
    expect(screen.getByRole("button", { name: "Resume search indexing" })).toBeInTheDocument();
  });

  it("shows a resume control for a paused queue with pending books", () => {
    renderChip(pausedIndexStatus);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing paused");
    expect(screen.getByRole("button", { name: "Resume search indexing" })).toBeInTheDocument();
  });

  it("gives metadata imports priority over search indexing", () => {
    renderChip(busyIndexStatus, scan({ scanning: true, pending: 3 }));
    expect(screen.getByRole("status")).toHaveTextContent("Importing 3 books");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows importing even when the knowledge API is unavailable", () => {
    const refresh = vi.fn(async () => null);
    render(
      <IndexChip
        scanStatus={scan({ pending: 1 })}
        index={null}
        scanError={false}
        api={vi.fn()}
        refresh={refresh}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Importing 1 book");
  });

  it("links the skipped duplicate count to the review card", () => {
    render(
      <MemoryRouter>
        <IndexChip
          scanStatus={scan({ skippedDuplicates: 214 })}
          index={null}
          scanError={false}
          api={vi.fn()}
          refresh={vi.fn(async () => null)}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /214 duplicates skipped/ });
    expect(link).toHaveAttribute("href", "/settings/duplicates");
  });

  it("shows the skipped count next to an import", () => {
    render(
      <MemoryRouter>
        <IndexChip
          scanStatus={scan({ scanning: true, pending: 2, skippedDuplicates: 3 })}
          index={null}
          scanError={false}
          api={vi.fn()}
          refresh={vi.fn(async () => null)}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Importing 2 books");
    expect(screen.getByRole("link", { name: /3 duplicates skipped/ })).toBeInTheDocument();
  });

  it("hides the skipped counter when nothing was skipped", () => {
    render(
      <MemoryRouter>
        <IndexChip
          scanStatus={scan({ skippedDuplicates: 0 })}
          index={null}
          scanError={false}
          api={vi.fn()}
          refresh={vi.fn(async () => null)}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /duplicates skipped/ })).not.toBeInTheDocument();
  });

  it("warns discretely when the scan status cannot be refreshed", () => {
    const refresh = vi.fn(async () => null);
    render(
      <IndexChip scanStatus={scan({ scanning: true })} index={busyIndexStatus} scanError api={vi.fn()} refresh={refresh} />,
    );
    const chip = screen.getByRole("status");
    expect(chip).toHaveTextContent("Can't reach the server. Retrying…");
    expect(chip).toHaveAttribute("aria-live", "polite");
  });
});
