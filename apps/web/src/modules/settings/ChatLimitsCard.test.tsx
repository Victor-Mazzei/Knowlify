import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../services/api";
import { ChatLimitsCard } from "./ChatLimitsCard";
import { createMockChatLimitsApi } from "./chatLimitsMock";

const renderCard = (api = createMockChatLimitsApi()) => render(<ChatLimitsCard api={api} />);

describe("ChatLimitsCard", () => {
  it("shows the count, the default source and the deletion warning", async () => {
    renderCard(createMockChatLimitsApi({ count: 12 }));
    expect(await screen.findByText("12 of 200 used")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sessions are never deleted automatically. When you reach the limit, you must delete one to start a new one.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByLabelText("Maximum sessions")).toHaveValue(200);
    expect(screen.getByRole("button", { name: "Use default" })).toBeDisabled();
  });

  it("validates 20 to 5000 before sending", async () => {
    let calls = 0;
    const api = createMockChatLimitsApi();
    renderCard(async (path, init) => {
      if (init?.method === "PUT") calls += 1;
      return api(path, init);
    });

    const input = await screen.findByLabelText("Maximum sessions");
    fireEvent.change(input, { target: { value: "19" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number from 20 to 5000.");
    expect(calls).toBe(0);

    fireEvent.change(input, { target: { value: "5001" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(calls).toBe(0);

    fireEvent.change(input, { target: { value: "20.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(calls).toBe(0);
  });

  it("saves a new limit and can go back to the default", async () => {
    renderCard(createMockChatLimitsApi({ count: 3 }));

    const input = await screen.findByLabelText("Maximum sessions");
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Saved. The new limit applies right away.")).toBeInTheDocument();
    expect(screen.getByText("3 of 250 used")).toBeInTheDocument();
    expect(screen.getByText("Saved here")).toBeInTheDocument();
    expect(screen.getByLabelText("Maximum sessions")).toHaveValue(250);

    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    expect(await screen.findByText("Using the default limit.")).toBeInTheDocument();
    expect(screen.getByText("3 of 200 used")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("can save an environment value as an override without changing the number", async () => {
    renderCard(createMockChatLimitsApi({ source: "env", maxConversations: 200 }));
    expect(await screen.findByText("From environment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved. The new limit applies right away.")).toBeInTheDocument();
    expect(screen.getByText("Saved here")).toBeInTheDocument();
  });

  it("respects the server lock", async () => {
    renderCard(createMockChatLimitsApi({ locked: true, source: "env", maxConversations: 80 }));
    expect(await screen.findByText("Managed by server")).toBeInTheDocument();
    expect(screen.getByLabelText("Maximum sessions")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use default" })).toBeDisabled();
    expect(
      screen.getByText("The server environment controls this setting. Ask the server owner to change it."),
    ).toBeInTheDocument();
  });

  it("shows the server error and keeps the value", async () => {
    const api = createMockChatLimitsApi();
    renderCard(async (path, init) => {
      if (init?.method === "PUT") {
        throw new ApiError(400, "Enter a whole number from 20 to 5000.", "invalid_value");
      }
      return api(path, init);
    });

    const input = await screen.findByLabelText("Maximum sessions");
    fireEvent.change(input, { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number from 20 to 5000."),
    );
    expect(input).toHaveValue(300);
  });
});
