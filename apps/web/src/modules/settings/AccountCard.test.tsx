import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, changePassword, getAccount, LOCAL_ONLY_MESSAGE, saveCredentials } from "../../services/api";
import { AccountCard } from "./AccountCard";

vi.mock("../../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api")>();
  return { ...actual, getAccount: vi.fn(), changePassword: vi.fn(), saveCredentials: vi.fn() };
});

const account = { user: "reader", canChangePassword: true, passwordSource: "user" as const };
const credentials = { user: "reader", pass: "current-pass" };

async function setup(info: Awaited<ReturnType<typeof getAccount>> = account) {
  vi.mocked(getAccount).mockResolvedValue(info);
  const onLogout = vi.fn();
  const onCredentialsChange = vi.fn();
  render(<AccountCard credentials={credentials} onLogout={onLogout} onCredentialsChange={onCredentialsChange} />);
  if (info.canChangePassword) await screen.findByLabelText("Current password");
  return { onLogout, onCredentialsChange };
}

const fill = (current: string, next: string, confirm: string) => {
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
};

beforeEach(() => vi.clearAllMocks());

describe("AccountCard", () => {
  it("shows the managed-password sentence and no form when the app owns the password", async () => {
    await setup({ ...account, canChangePassword: false, passwordSource: "env" });
    expect(await screen.findByText("Your password is managed by the app.")).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("blocks invalid input in the client and focuses the first error", async () => {
    await setup();
    const form = (screen.getByLabelText("Current password")).closest("form") as HTMLFormElement;
    const submit = screen.getByRole("button", { name: "Change password" });

    fill("current-pass", "short", "short");
    expect(submit).toBeDisabled();
    fireEvent.submit(form);
    expect(screen.getByRole("alert")).toHaveTextContent("between 8 and 200");
    expect(screen.getByLabelText("New password")).toHaveFocus();

    fill("current-pass", "next-password", "other-password");
    expect(submit).toBeDisabled();
    fireEvent.submit(form);
    expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match.");
    expect(screen.getByLabelText("Confirm new password")).toHaveFocus();

    fill("current-pass", "current-pass", "current-pass");
    expect(submit).toBeDisabled();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("sends {current,next}, clears the form, confirms and keeps the new credentials", async () => {
    const { onLogout, onCredentialsChange } = await setup();
    vi.mocked(changePassword).mockResolvedValue(undefined);

    fill("current-pass", "next-password", "next-password");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith(credentials, { current: "current-pass", next: "next-password" }, onLogout),
    );
    expect(
      await screen.findByText("Password changed. Other devices, including KOReader, need the new password."),
    ).toBeInTheDocument();
    expect(saveCredentials).toHaveBeenCalledWith({ user: "reader", pass: "next-password" });
    expect(onCredentialsChange).toHaveBeenCalledWith({ user: "reader", pass: "next-password" });
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("shows a 403 inline without logging out or changing credentials", async () => {
    const { onCredentialsChange } = await setup();
    vi.mocked(changePassword).mockRejectedValue(new ApiError(403, "Current password is incorrect"));

    fill("wrong-pass", "next-password", "next-password");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Current password is incorrect");
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(onCredentialsChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("New password")).toHaveValue("next-password");
  });

  it("explains a local-only password change without signing out", async () => {
    const { onLogout, onCredentialsChange } = await setup();
    vi.mocked(changePassword).mockRejectedValue(new ApiError(403, "Forbidden", "local_only"));

    fill("current-pass", "next-password", "next-password");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(LOCAL_ONLY_MESSAGE);
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(onCredentialsChange).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("explains a local-only account read instead of a generic forbidden error", async () => {
    vi.mocked(getAccount).mockRejectedValue(new ApiError(403, "Forbidden", "local_only"));
    const onLogout = vi.fn();
    render(
      <AccountCard
        credentials={credentials}
        onLogout={onLogout}
        onCredentialsChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(LOCAL_ONLY_MESSAGE);
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("maps 429 to the fixed retry message", async () => {
    await setup();
    vi.mocked(changePassword).mockRejectedValue(new ApiError(429, "rate limited"));

    fill("current-pass", "next-password", "next-password");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts. Try again in a minute.");
    expect(saveCredentials).not.toHaveBeenCalled();
  });
});
