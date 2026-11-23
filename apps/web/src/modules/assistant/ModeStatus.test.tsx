import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModeStatus } from "./ModeStatus";

describe("ModeStatus", () => {
  it("says Ask is not saved and whether the library is on", () => {
    const { rerender } = render(
      <ModeStatus mode="ask" useLibrary scopeLabel="Whole library" hasSession={false} />,
    );
    expect(screen.getByText("Ask · not saved · library on")).toBeInTheDocument();
    expect(screen.getByText("Whole library")).toBeInTheDocument();

    rerender(<ModeStatus mode="ask" useLibrary={false} scopeLabel="This book" hasSession={false} />);
    expect(screen.getByText("Ask · not saved · library off")).toBeInTheDocument();
    expect(screen.getByText("This book")).toBeInTheDocument();
  });

  it("names a saved session and its scope", () => {
    render(
      <ModeStatus
        mode="session"
        useLibrary
        scopeLabel="This book"
        sessionTitle="Rust ownership"
        hasSession
      />,
    );
    expect(screen.getByText("Session · saved · Rust ownership")).toBeInTheDocument();
    expect(screen.getByText("This book")).toBeInTheDocument();
  });

  it("says a new session will be saved with the first answer", () => {
    render(<ModeStatus mode="session" useLibrary scopeLabel="Whole library" hasSession={false} />);
    expect(screen.getByText("New session · saves with your first answer")).toBeInTheDocument();
  });
});
