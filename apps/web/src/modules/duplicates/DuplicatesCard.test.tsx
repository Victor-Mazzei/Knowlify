import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { DuplicatesCard } from "./DuplicatesCard";
import { createMockDuplicatesApi } from "./mockDuplicatesApi";
import { manyDuplicateGroups } from "./mockDuplicatesData";
import type { MergeAccepted, MergeTarget } from "./types";

const renderCard = (api: ApiFn, initialEntries = ["/settings"]) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <DuplicatesCard api={api} />
    </MemoryRouter>,
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const firstGroupKey = `1800000:${"a".repeat(64)}`;

type MergeCall = { dryRun: boolean; groups?: MergeTarget[] | "all"; confirm?: MergeAccepted[] };

function recordingApi(base: ApiFn, calls: MergeCall[]): ApiFn {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/duplicates/merge" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as {
        groups?: MergeTarget[] | "all";
        confirm?: MergeAccepted[];
        dryRun?: boolean;
      };
      calls.push({ dryRun: body.dryRun === true, groups: body.groups, confirm: body.confirm });
    }
    return base(path, init);
  });
}

describe("DuplicatesCard", () => {
  it("summarizes groups and exposes the canonical choice per copy", async () => {
    renderCard(createMockDuplicatesApi());
    expect(await screen.findByText(/3 groups · 4 redundant books · ~7.2 MB of index/)).toBeInTheDocument();

    const group = screen.getByRole("group", { name: /The Left Hand of Darkness/ });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(within(group).getByText("Suggested")).toBeInTheDocument();
    expect(within(group).getByText(/1 more file already points here/)).toBeInTheDocument();
    expect(within(group).getByRole("img", { name: "Has notes" })).toBeInTheDocument();
  });

  it("checks a dry-run and then merges the loaded groups", async () => {
    const calls: MergeCall[] = [];
    renderCard(recordingApi(createMockDuplicatesApi(), calls));

    await screen.findByText(/3 groups · 4 redundant books/);
    fireEvent.click(screen.getByRole("button", { name: "Review & merge" }));

    const dialog = await screen.findByRole("dialog", { name: "Review 3 groups" });
    expect(
      within(dialog).getByText("Notes and progress are kept. Files in your folders are never deleted."),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText("Duplicate records removed")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ dryRun: true, groups: expect.any(Array) });

    fireEvent.click(await within(dialog).findByRole("button", { name: "Merge 3 groups" }));
    expect(await screen.findByText(/Merged 3 groups/)).toBeInTheDocument();
    expect(await screen.findByText("No duplicates found.")).toBeInTheDocument();
    expect(calls[1]).toMatchObject({ dryRun: false, confirm: expect.any(Array), groups: expect.any(Array) });
    expect(calls[1]?.groups).toEqual(calls[0]?.groups);
    expect(calls[1]?.confirm).toHaveLength(3);
    expect(calls[1]?.confirm?.every((item) => item.fingerprint.length > 0)).toBe(true);
  });

  it("sends the copy picked with the canonical radio", async () => {
    const calls: MergeCall[] = [];
    renderCard(recordingApi(createMockDuplicatesApi(), calls));

    const group = await screen.findByRole("group", { name: /The Left Hand of Darkness/ });
    const radios = within(group).getAllByRole("radio");
    fireEvent.click(radios[1]!);
    expect(radios[1]).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Review & merge" }));
    const dialog = await screen.findByRole("dialog", { name: "Review 3 groups" });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect((calls[0]!.groups as Array<{ key: string; canonicalId?: string }>)[0]).toMatchObject({
      key: firstGroupKey,
      canonicalId: "dup-lh-2",
    });

    fireEvent.click(await within(dialog).findByRole("button", { name: "Merge 3 groups" }));
    await waitFor(() => expect(calls.some((call) => !call.dryRun)).toBe(true));
    const merge = calls.find((call) => !call.dryRun)!;
    expect((merge.groups as Array<{ key: string; canonicalId?: string }>)[0]).toMatchObject({
      key: firstGroupKey,
      canonicalId: "dup-lh-2",
    });
    expect(merge.confirm).toHaveLength(3);
    expect(await screen.findByText(/Merged 3 groups/)).toBeInTheDocument();
  });

  it("keeps the dialog open and shows a 409 from the merge", async () => {
    renderCard(createMockDuplicatesApi({ scenario: "conflict" }));
    await screen.findByText(/3 groups · 4 redundant books/);
    fireEvent.click(screen.getByRole("button", { name: "Merge all" }));

    const dialog = await screen.findByRole("dialog", { name: "Merge every duplicate?" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Merge all 3 groups" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Another duplicate merge is already running.",
    );
    expect(within(dialog).getByRole("button", { name: "Merge all 3 groups" })).toBeInTheDocument();
  });

  it("checks and merges more than 500 groups in matching batches", async () => {
    const seeded = manyDuplicateGroups(650);
    const calls: MergeCall[] = [];
    renderCard(recordingApi(createMockDuplicatesApi({ groups: seeded }), calls));
    await screen.findByText(/650 groups · 780 redundant books/);

    fireEvent.click(screen.getByRole("button", { name: "Merge all" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge every duplicate?" });
    const confirm = await within(dialog).findByRole("button", { name: "Merge all 650 groups" });
    const plan = within(dialog).getByLabelText("Merge plan");
    expect(plan).toHaveTextContent("650");
    expect(plan).toHaveTextContent("780");
    expect(within(dialog).getByText(/runs in 2 batches of up to 500 groups/)).toBeInTheDocument();
    expect(
      within(dialog).getByText("780 uploaded file(s) will be removed from the app data directory."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/^500 uploaded file/)).not.toBeInTheDocument();

    fireEvent.click(confirm);
    expect(await screen.findByText(/Merged 650 groups\. 780 duplicate records removed\./)).toBeInTheDocument();
    expect(await screen.findByText("No duplicates found.")).toBeInTheDocument();

    const dryRuns = calls.filter((call) => call.dryRun);
    const merges = calls.filter((call) => !call.dryRun);
    expect(dryRuns.map((call) => (call.groups as MergeTarget[]).length)).toEqual([500, 150]);
    expect(merges.map((call) => call.confirm?.length)).toEqual([500, 150]);
    expect(merges.map((call) => (call.groups as MergeTarget[]).length)).toEqual([500, 150]);
    expect((merges[0]?.groups as MergeTarget[]).map((item) => item.key)).toEqual(
      (dryRuns[0]?.groups as MergeTarget[]).map((item) => item.key),
    );
  });

  it("reports skipped and remaining groups after a batched merge", async () => {
    const seeded = manyDuplicateGroups(650);
    const skip = new Set([seeded[11]!.key, seeded[601]!.key]);
    renderCard(createMockDuplicatesApi({ groups: seeded, skipMergeKeys: skip }));
    await screen.findByText(/650 groups · 780 redundant books/);

    fireEvent.click(screen.getByRole("button", { name: "Merge all" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge every duplicate?" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Merge all 650 groups" }));

    expect(await screen.findByText(/Merged 648 groups\. 778 duplicate records removed\./)).toBeInTheDocument();
    expect(screen.getByText(/2 groups changed while reviewing; analyze again to refresh\./)).toBeInTheDocument();
    expect(screen.getByText(/2 groups still need review\./)).toBeInTheDocument();
    expect(await screen.findByText(/2 groups · 2 redundant books/)).toBeInTheDocument();
  });

  it("shows and confirms only the groups a dry-run accepted", async () => {
    const seeded = manyDuplicateGroups(650);
    const omitted = seeded[0]!.key;
    const calls: MergeCall[] = [];
    renderCard(
      recordingApi(
        createMockDuplicatesApi({ groups: seeded, skipDryRunKeys: new Set([omitted]) }),
        calls,
      ),
    );
    await screen.findByText(/650 groups · 780 redundant books/);

    fireEvent.click(screen.getByRole("button", { name: "Merge all" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge every duplicate?" });
    expect(await within(dialog).findByRole("button", { name: "Merge 649 of 650 groups" })).toBeInTheDocument();
    expect(within(dialog).getByText(/1 group changed and was left out/)).toBeInTheDocument();
    const plan = within(dialog).getByLabelText("Merge plan");
    expect(plan).toHaveTextContent("649");
    expect(plan).toHaveTextContent("778");

    fireEvent.click(within(dialog).getByRole("button", { name: "Merge 649 of 650 groups" }));
    expect(await screen.findByText(/Merged 649 groups\. 778 duplicate records removed\./)).toBeInTheDocument();
    expect(screen.queryByText(/changed while reviewing/)).not.toBeInTheDocument();
    expect(await screen.findByText(/1 group still needs review\./)).toBeInTheDocument();
    expect(await screen.findByText(/1 group · 2 redundant books/)).toBeInTheDocument();

    // Two dry-run and two merge batches for the 649 accepted groups; a re-review
    // of the omitted group would add a third call of each.
    expect(calls.filter((call) => call.dryRun)).toHaveLength(2);
    expect(calls.filter((call) => !call.dryRun)).toHaveLength(2);
    const confirm = calls.filter((call) => !call.dryRun).flatMap((call) => call.confirm ?? []);
    expect(confirm).toHaveLength(649);
    expect(confirm.map((item) => item.key)).not.toContain(omitted);
    const confirmedGroups = calls
      .filter((call) => !call.dryRun)
      .flatMap((call) => (call.groups as MergeTarget[] | undefined) ?? []);
    expect(confirmedGroups).toHaveLength(649);
    expect(confirmedGroups.map((item) => item.key)).not.toContain(omitted);
  });

  it("does not merge a group that changed between review and confirmation", async () => {
    const seeded = manyDuplicateGroups(3);
    const changed = seeded[1]!.key;
    renderCard(createMockDuplicatesApi({ groups: seeded, skipMergeKeys: new Set([changed]) }));
    await screen.findByText(/3 groups · 4 redundant books/);

    fireEvent.click(screen.getByRole("button", { name: "Review & merge" }));
    const dialog = await screen.findByRole("dialog", { name: "Review 3 groups" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Merge 3 groups" }));

    expect(await screen.findByText(/Merged 2 groups\. 3 duplicate records removed\./)).toBeInTheDocument();
    expect(await screen.findByText(/1 group changed while reviewing/)).toBeInTheDocument();
    expect(await screen.findByText(/1 group still needs review\./)).toBeInTheDocument();
    expect(await screen.findByText(/1 group · 1 redundant book/)).toBeInTheDocument();
  });

  it("shows the report without a merge action on an older server", async () => {
    const base = createMockDuplicatesApi();
    const api: ApiFn = vi.fn(async (path: string, init?: RequestInit) => {
      const response = await base(path, init);
      if (path !== "/api/duplicates/merge" || typeof init?.body !== "string") return response;
      const body = JSON.parse(init.body) as { dryRun?: boolean };
      if (body.dryRun !== true) return response;
      const payload = (await response.json()) as Record<string, unknown>;
      delete payload.accepted;
      delete payload.omitted;
      return json(payload);
    });
    renderCard(api);
    await screen.findByText(/3 groups · 4 redundant books/);

    fireEvent.click(screen.getByRole("button", { name: "Review & merge" }));
    const dialog = await screen.findByRole("dialog", { name: "Review 3 groups" });
    expect(await within(dialog).findByText("Duplicate records removed")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Merge/ })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/does not support reviewed merges/)).toBeInTheDocument();
  });

  it("shows an empty state when nothing is duplicated", async () => {
    renderCard(createMockDuplicatesApi({ scenario: "empty" }));
    expect(await screen.findByText("No duplicates found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review & merge" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze now" })).toBeInTheDocument();
  });

  it("shows analysis progress and blocks merging while hashing", async () => {
    renderCard(createMockDuplicatesApi({ scenario: "hashing" }));
    expect(await screen.findByText("Analyzing… 38%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Analyzing duplicate groups" })).toHaveAttribute(
      "aria-valuenow",
      "38",
    );
    expect(screen.queryByRole("button", { name: "Analyze now" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review & merge" })).toBeDisabled();
  });

  it("closes the review with Escape", async () => {
    renderCard(createMockDuplicatesApi());
    await screen.findByText(/3 groups · 4 redundant books/);
    fireEvent.click(screen.getByRole("button", { name: "Review & merge" }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("focuses the card when reached through its legacy anchor", async () => {
    renderCard(createMockDuplicatesApi(), ["/settings#duplicates"]);
    await screen.findByText(/3 groups · 4 redundant books/);
    expect(document.getElementById("duplicates")).toHaveFocus();
  });

  it("stays hidden on a server without the duplicates route", async () => {
    const api = vi.fn(async (path: string) =>
      path === "/api/scan" ? json({ scanning: false, pending: 0, lastScanAt: null }) : json({ message: "Not found" }, 404),
    );
    const { container } = renderCard(api);
    await waitFor(() => expect(container.querySelector("#duplicates")).toBeNull());
  });
});
