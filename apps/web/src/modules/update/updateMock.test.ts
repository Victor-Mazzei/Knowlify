import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateApi } from "./updateApi";
import {
  createMockUpdateApi,
  mockUpdateScenario,
  type MockUpdateScenario,
} from "./updateMock";

const client = (scenario: MockUpdateScenario) =>
  createUpdateApi(createMockUpdateApi({ scenario }));

afterEach(() => {
  vi.useRealTimers();
});

describe("update mock", () => {
  it("selects the cooldown scenario from the query", () => {
    expect(mockUpdateScenario("cooldown")).toBe("cooldown");
    expect(mockUpdateScenario("bogus")).toBe("available");
  });

  it("serves the cache inside the cooldown without advancing checkedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
    const api = client("cooldown");

    const before = await api.get();
    const after = await api.check();

    expect(after?.checkedAt).toBe(before?.checkedAt);
    expect(after?.available).toBe(true);
    expect(after?.latest?.version).toBe("2.5.0");
  });

  it("advances on a real check and caches the next 60 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
    const api = client("available");

    expect((await api.check())?.checkedAt).toBe("2026-11-25T12:00:00.000Z");

    vi.setSystemTime(new Date("2026-11-25T12:00:30.000Z"));
    expect((await api.check())?.checkedAt).toBe("2026-11-25T12:00:00.000Z");

    vi.setSystemTime(new Date("2026-11-25T12:01:01.000Z"));
    expect((await api.check())?.checkedAt).toBe("2026-11-25T12:01:01.000Z");
  });
});
