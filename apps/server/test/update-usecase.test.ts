import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteUpdateConfigStore, SqliteUpdateStateStore } from "../src/adapters/update/SqliteUpdateStore.js";
import type { ReleaseFetchResult, ReleaseSource, UpdateConfigStore } from "../src/ports/update.js";
import { UpdateNotice, type UpdateNoticeOptions } from "../src/use-cases/UpdateNotice.js";

const START = Date.parse("2026-11-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeSource implements ReleaseSource {
  readonly calls: Array<string | null> = [];
  constructor(private readonly respond: () => ReleaseFetchResult | Promise<ReleaseFetchResult>) {}
  async latest(etag: string | null): Promise<ReleaseFetchResult> {
    this.calls.push(etag);
    return this.respond();
  }
}

const ok = (tag = "v2.5.0", etag: string | null = 'W/"one"'): ReleaseFetchResult => ({
  outcome: "ok",
  release: {
    tag,
    version: {
      major: tag.slice(1).split(".")[0]!,
      minor: tag.slice(1).split(".")[1]!,
      patch: tag.slice(1).split(".")[2]!,
      prerelease: [],
    },
  },
  etag,
});

interface Harness {
  db: Db;
  notice: UpdateNotice;
  source: FakeSource;
  state: SqliteUpdateStateStore;
  config: SqliteUpdateConfigStore;
  setNow(value: number): void;
}

function harness(
  respond: () => ReleaseFetchResult | Promise<ReleaseFetchResult>,
  overrides: Partial<UpdateNoticeOptions> = {},
  db: Db = openDb(":memory:"),
): Harness {
  let now = START;
  const state = new SqliteUpdateStateStore(db);
  const config = new SqliteUpdateConfigStore(db);
  const source = new FakeSource(respond);
  const clock = { now: () => now };
  const notice = new UpdateNotice({
    currentVersion: "2.4.0",
    env: { enabled: true },
    locked: false,
    source,
    stateStore: state,
    configStore: config,
    clock,
    ...overrides,
  });
  notice.bootstrap();
  return {
    db,
    notice,
    source,
    state,
    config,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("UpdateNotice cache and laziness", () => {
  it("triggers exactly one lazy check on a read and then serves the cache", async () => {
    const test = harness(() => ok());
    const first = test.notice.view(true);
    expect(first.latest).toBeNull();
    expect(first.checkedAt).toBeNull();
    await flush();
    expect(test.source.calls).toHaveLength(1);

    const second = test.notice.view(true);
    expect(second.latest).toEqual({
      version: "2.5.0",
      url: "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0",
    });
    expect(second.available).toBe(true);
    expect(second.checkedAt).toBe(new Date(START).toISOString());
    await flush();
    expect(test.source.calls).toHaveLength(1);
  });

  it("does not schedule a lazy check for a peer without management rights", async () => {
    const test = harness(() => ok());
    const remote = test.notice.view(false);
    expect(remote).toMatchObject({ canManage: false, latest: null, checkedAt: null });
    await flush();
    expect(test.source.calls).toHaveLength(0);

    test.notice.view(true);
    await flush();
    expect(test.source.calls).toHaveLength(1);
  });

  it("refreshes only after the 24 h interval", async () => {
    const test = harness(() => ok());
    await test.notice.checkNow(true);
    expect(test.source.calls).toHaveLength(1);

    test.setNow(START + DAY - 1);
    test.notice.view(true);
    await flush();
    expect(test.source.calls).toHaveLength(1);

    test.setNow(START + DAY + 1);
    test.notice.view(true);
    await flush();
    expect(test.source.calls).toHaveLength(2);
  });

  it("keeps the last tag on 304 and updates checkedAt", async () => {
    const test = harness(() => ok());
    await test.notice.checkNow(true);
    test.setNow(START + DAY + 1);
    const second = new UpdateNotice({
      currentVersion: "2.4.0",
      env: { enabled: true },
      locked: false,
      source: new FakeSource(() => ({ outcome: "not_modified", etag: 'W/"two"' })),
      stateStore: test.state,
      configStore: test.config,
      clock: { now: () => START + DAY + 1 },
    });
    second.bootstrap();
    const view = await second.checkNow(true);
    expect(view.latest?.version).toBe("2.5.0");
    expect(view.checkedAt).toBe(new Date(START + DAY + 1).toISOString());
    expect(test.state.load()).toMatchObject({ latestTag: "v2.5.0", etag: 'W/"two"', failures: 0 });
  });

  it("shares one in-flight fetch across concurrent calls", async () => {
    let release!: (result: ReleaseFetchResult) => void;
    const gate = new Promise<ReleaseFetchResult>((resolve) => {
      release = resolve;
    });
    const test = harness(() => gate);
    const calls = [test.notice.checkNow(true), test.notice.checkNow(true), test.notice.checkNow(true)];
    await flush();
    expect(test.source.calls).toHaveLength(1);
    release(ok());
    await Promise.all(calls);
    expect(test.source.calls).toHaveLength(1);
  });
});

describe("UpdateNotice silencing and backoff", () => {
  it("makes zero calls when the check is off, and hides a cached release", async () => {
    const db = openDb(":memory:");
    new SqliteUpdateStateStore(db).save({
      latestTag: "v2.5.0",
      etag: 'W/"saved"',
      checkedAt: START,
      nextAttemptAt: null,
      failures: 0,
    });
    const test = harness(() => ok(), { env: { enabled: false } }, db);
    const view = test.notice.view(true);
    expect(view).toMatchObject({ enabled: false, latest: null, available: false, checkedAt: null });
    await test.notice.checkNow(true);
    await flush();
    expect(test.source.calls).toHaveLength(0);
  });

  it("ignores the saved toggle when the environment locks it off", async () => {
    const db = openDb(":memory:");
    new SqliteUpdateConfigStore(db).save(true);
    const test = harness(() => ok(), { locked: true, env: { enabled: false } }, db);
    expect(test.notice.settings()).toEqual({ enabled: false, locked: true, source: "env" });
    expect(test.notice.view(true).latest).toBeNull();
    await test.notice.checkNow(true);
    expect(test.source.calls).toHaveLength(0);
    expect(() => test.notice.updateSettings({ enabled: true })).toThrow(/managed by the server environment/);
  });

  it("does not call again during the 60 s cooldown", async () => {
    const test = harness(() => ok());
    await test.notice.checkNow(true);
    test.setNow(START + 30_000);
    await test.notice.checkNow(true);
    expect(test.source.calls).toHaveLength(1);
    test.setNow(START + 61_000);
    await test.notice.checkNow(true);
    expect(test.source.calls).toHaveLength(2);
  });

  it("backs off from 1 h to 24 h and resets on success", async () => {
    let result: ReleaseFetchResult = { outcome: "failed", reason: "http_error", status: 500 };
    const test = harness(() => result);

    await test.notice.checkNow(true);
    expect(test.state.load()?.nextAttemptAt).toBe(START + HOUR);
    expect(test.state.load()?.failures).toBe(1);

    test.setNow(START + 30 * 60 * 1000);
    await test.notice.checkNow(true);
    expect(test.source.calls).toHaveLength(1);

    test.setNow(START + HOUR + 1);
    await test.notice.checkNow(true);
    expect(test.source.calls).toHaveLength(2);
    expect(test.state.load()?.failures).toBe(2);
    expect(test.state.load()?.nextAttemptAt).toBe(START + HOUR + 1 + 2 * HOUR);

    result = ok();
    test.setNow(START + 4 * HOUR);
    await test.notice.checkNow(true);
    expect(test.state.load()).toMatchObject({ failures: 0, nextAttemptAt: null, latestTag: "v2.5.0" });
  });

  it("honours Retry-After, bounded to 1 h–24 h", async () => {
    for (const [retryAfterMs, expected] of [
      [60_000, HOUR],
      [2 * HOUR, 2 * HOUR],
      [48 * HOUR, 24 * HOUR],
    ] as const) {
      const test = harness(() => ({ outcome: "failed", reason: "rate_limited", status: 429, retryAfterMs }));
      await test.notice.checkNow(true);
      expect(test.state.load()?.nextAttemptAt).toBe(START + expected);
    }
  });

  it("keeps the last good release when a later check fails", async () => {
    let result: ReleaseFetchResult = ok();
    const test = harness(() => result);
    await test.notice.checkNow(true);
    result = { outcome: "failed", reason: "bad_tag", status: 200 };
    test.setNow(START + 61_000);
    const view = await test.notice.checkNow(true);
    expect(view.latest?.version).toBe("2.5.0");
    expect(view.available).toBe(true);
    expect(view.checkedAt).toBe(new Date(START).toISOString());
    expect(test.state.load()?.failures).toBe(1);
  });

  it("reuses the persisted cache after a restart", async () => {
    const db = openDb(":memory:");
    const first = harness(() => ok(), {}, db);
    await first.notice.checkNow(true);
    expect(first.source.calls).toHaveLength(1);

    const second = harness(() => ok(), {}, db);
    const view = second.notice.view(true);
    await flush();
    expect(view.latest?.version).toBe("2.5.0");
    expect(second.source.calls).toHaveLength(0);
  });

  it("discards the cache when the user turns the check off", async () => {
    const test = harness(() => ok());
    await test.notice.checkNow(true);
    expect(test.notice.updateSettings({ enabled: false })).toEqual({
      enabled: false,
      locked: false,
      source: "db",
    });
    expect(test.state.load()).toBeNull();
    expect(test.notice.view(true)).toMatchObject({ enabled: false, latest: null, checkedAt: null });
    await test.notice.checkNow(true);
    expect(test.source.calls).toHaveLength(1);
  });

  it("discards a check that resolves after the user turned it off", async () => {
    let release!: (result: ReleaseFetchResult) => void;
    const gate = new Promise<ReleaseFetchResult>((resolve) => {
      release = resolve;
    });
    const test = harness(() => gate);
    const pending = test.notice.checkNow(true);
    await flush();
    expect(test.source.calls).toHaveLength(1);

    test.notice.updateSettings({ enabled: false });
    expect(test.state.load()).toBeNull();

    release(ok());
    await pending;

    expect(test.state.load()).toBeNull();
    expect(test.notice.view(false).latest).toBeNull();

    test.notice.updateSettings({ enabled: true });
    expect(test.notice.view(false)).toMatchObject({ enabled: true, latest: null, checkedAt: null });
    expect(test.state.load()).toBeNull();

    // Only a peer allowed to manage the check schedules the lazy refresh.
    expect(test.notice.view(true)).toMatchObject({ enabled: true, latest: null, checkedAt: null });
    await flush();
    expect(test.source.calls).toHaveLength(2);
    expect(test.notice.view(false).latest?.version).toBe("2.5.0");
  });

  it("discards a check when the user turns it off and on before it resolves", async () => {
    let release!: (result: ReleaseFetchResult) => void;
    const gate = new Promise<ReleaseFetchResult>((resolve) => {
      release = resolve;
    });
    const test = harness(() => gate);
    const pending = test.notice.checkNow(true);
    await flush();
    expect(test.source.calls).toHaveLength(1);

    test.notice.updateSettings({ enabled: false });
    test.notice.updateSettings({ enabled: true });
    expect(test.source.calls).toHaveLength(1);

    release(ok());
    await pending;

    expect(test.state.load()).toBeNull();
    expect(test.notice.view(false).latest).toBeNull();
  });

  it("keeps the previous toggle and cache when saving the toggle fails", () => {
    const db = openDb(":memory:");
    new SqliteUpdateStateStore(db).save({
      latestTag: "v2.5.0",
      etag: 'W/"saved"',
      checkedAt: START,
      nextAttemptAt: null,
      failures: 0,
    });
    const failingConfig: UpdateConfigStore = {
      load: () => null,
      save: () => {
        throw new Error("settings write failed");
      },
    };
    const test = harness(() => ok(), { configStore: failingConfig }, db);
    expect(test.notice.settings()).toEqual({ enabled: true, locked: false, source: "env" });

    expect(() => test.notice.updateSettings({ enabled: false })).toThrow("settings write failed");

    expect(test.notice.settings()).toEqual({ enabled: true, locked: false, source: "env" });
    expect(test.config.load()).toBeNull();
    expect(test.state.load()).not.toBeNull();
    expect(test.notice.view(true).latest?.version).toBe("2.5.0");
  });
});

describe("UpdateNotice settings", () => {
  it("resolves default, environment, database and locked sources", () => {
    const unset = harness(() => ok(), { env: { enabled: null } });
    expect(unset.notice.settings()).toEqual({ enabled: true, locked: false, source: "default" });

    const envOff = harness(() => ok(), { env: { enabled: false } });
    expect(envOff.notice.settings()).toEqual({ enabled: false, locked: false, source: "env" });

    const stored = harness(() => ok(), { env: { enabled: false } });
    expect(stored.notice.updateSettings({ enabled: true })).toEqual({
      enabled: true,
      locked: false,
      source: "db",
    });
    expect(stored.notice.isEnabled()).toBe(true);
    expect(stored.config.load()).toBe(true);

    stored.notice.updateSettings({ enabled: false });
    expect(stored.config.load()).toBe(false);
  });

  it("rejects anything but exactly one boolean field", () => {
    const test = harness(() => ok());
    for (const body of [
      null,
      undefined,
      [],
      {},
      { enabled: "true" },
      { enabled: 1 },
      { enabled: true, extra: true },
      { enabled: true, enabledAgain: false },
    ]) {
      expect(() => test.notice.updateSettings(body)).toThrow();
      try {
        test.notice.updateSettings(body);
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_body", status: 400 });
      }
    }
  });
});
