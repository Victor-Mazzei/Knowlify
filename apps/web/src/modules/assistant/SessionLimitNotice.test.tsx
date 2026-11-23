import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionLimitNotice } from "./SessionLimitNotice";

const renderNotice = (props: { limit: number; count: number; blocked?: boolean }) =>
  render(
    <MemoryRouter>
      <SessionLimitNotice {...props} />
    </MemoryRouter>,
  );

describe("SessionLimitNotice", () => {
  it("names the limit and links to the setting", () => {
    renderNotice({ limit: 200, count: 200, blocked: true });
    expect(screen.getByRole("status")).toHaveTextContent(
      "You reached the session limit (200). Delete a session, or raise the limit in Settings → AI.",
    );
    expect(screen.getByRole("link", { name: "Settings → AI" })).toHaveAttribute("href", "/settings/ai");
  });

  it("explains a limit reduced below the existing count", () => {
    renderNotice({ limit: 20, count: 25 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "You have 25 sessions; the limit is 20. Existing sessions still work.",
    );
  });
});
