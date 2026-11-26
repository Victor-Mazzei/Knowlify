import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { createUpdateApi } from "./updateApi";
import type { UpdateInfo, UpdateSettings } from "./updateTypes";

const INFO: UpdateInfo = {
  enabled: true,
  locked: false,
  canManage: true,
  current: "2.4.0",
  latest: {
    version: "2.5.0",
    url: "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0",
  },
  available: true,
  checkedAt: "2026-11-25T12:00:00.000Z",
};

const SETTINGS: UpdateSettings = { enabled: true, locked: false, source: "db" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Call = { path: string; init?: RequestInit };

const spyApi = (handler: (path: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const api: ApiFn = async (path, init) => {
    calls.push({ path, init });
    return handler(path, init);
  };
  return { api, calls };
};

describe("updateApi", () => {
  it("reads the notice without caching", async () => {
    const { api, calls } = spyApi(() => json(INFO));
    const info = await createUpdateApi(api).get();

    expect(info).toEqual(INFO);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/update");
    expect(calls[0].init).toMatchObject({ method: "GET", cache: "no-store" });
  });

  it("treats a missing route or an unexpected shape as absent", async () => {
    expect(await createUpdateApi(spyApi(() => json({}, 404)).api).get()).toBeNull();
    expect(
      await createUpdateApi(async () => {
        throw new ApiError(404, "Request failed (404)");
      }).get(),
    ).toBeNull();
    expect(await createUpdateApi(spyApi(() => json({ ...INFO, enabled: "yes" })).api).get()).toBeNull();
    expect(
      await createUpdateApi(
        spyApi(() => json({ ...INFO, latest: { version: "2.5.0" } })).api,
      ).get(),
    ).toBeNull();
    expect(await createUpdateApi(spyApi(() => new Response("not json")).api).get()).toBeNull();
  });

  it("keeps a network failure visible to the caller", async () => {
    const failure = new Error("Could not reach the server.");
    const client = createUpdateApi(async () => {
      throw failure;
    });
    await expect(client.get()).rejects.toBe(failure);
  });

  it("checks now with a POST and the same shape", async () => {
    const checked = { ...INFO, checkedAt: "2026-11-25T13:00:00.000Z" };
    const { api, calls } = spyApi(() => json(checked));
    const info = await createUpdateApi(api).check();

    expect(info).toEqual(checked);
    expect(calls[0]).toMatchObject({ path: "/api/update/check", init: { method: "POST" } });
  });

  it("returns null when the check response is unusable", async () => {
    expect(await createUpdateApi(spyApi(() => json({ available: true })).api).check()).toBeNull();
  });

  it("reads and writes the setting", async () => {
    const { api, calls } = spyApi(() => json(SETTINGS));
    const client = createUpdateApi(api);

    expect(await client.getSettings()).toEqual(SETTINGS);
    expect(calls[0]).toMatchObject({ path: "/api/settings/update", init: { method: "GET" } });

    expect(await client.setEnabled(false)).toEqual(SETTINGS);
    expect(calls[1].path).toBe("/api/settings/update");
    expect(calls[1].init).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
  });

  it("keeps the error code of a rejected setting write", async () => {
    const api: ApiFn = async () =>
      json({ message: "Forbidden", code: "local_only" }, 403);
    const error = await createUpdateApi(api)
      .setEnabled(false)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "local_only" });
  });

  it("rejects an unusable setting write", async () => {
    await expect(
      createUpdateApi(spyApi(() => json({ enabled: true })).api).setEnabled(false),
    ).rejects.toThrow("unexpected response");
  });
});
