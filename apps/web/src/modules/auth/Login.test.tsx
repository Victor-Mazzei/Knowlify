import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Login } from "./Login";

describe("Login", () => {
  it("submits the credentials", async () => {
    const onLogin = vi.fn(async () => undefined);
    const { container } = render(<Login onLogin={onLogin} />);
    const mark = container.querySelector(".brand svg");
    expect(mark).toHaveAttribute("width", "40");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "reader" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter library" }));
    expect(onLogin).toHaveBeenCalledWith({ user: "reader", pass: "secret" });
  });

  it("shows a rejected login", async () => {
    render(<Login onLogin={vi.fn(async () => { throw new Error("Incorrect username or password."); })} />);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "reader" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter library" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect username or password.");
  });
});
