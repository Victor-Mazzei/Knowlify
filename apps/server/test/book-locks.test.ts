import { describe, expect, it } from "vitest";
import { BookLocks } from "../src/use-cases/BookLocks.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("BookLocks", () => {
  it("runs operations on the same book in call order", async () => {
    const locks = new BookLocks();
    const gate = deferred();
    const events: string[] = [];

    const first = locks.run("b", async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = locks.run("b", async () => { events.push("second"); });

    await tick();
    expect(events).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not serialize different books", async () => {
    const locks = new BookLocks();
    const gate = deferred();
    const events: string[] = [];

    const blocked = locks.run("a", async () => {
      await gate.promise;
      events.push("a");
    });
    await locks.run("b", async () => { events.push("b"); });

    expect(events).toEqual(["b"]);
    gate.resolve();
    await blocked;
    expect(events).toEqual(["b", "a"]);
  });

  it("acquires several books in a stable order and releases when work throws", async () => {
    const locks = new BookLocks();
    const gate = deferred();
    const events: string[] = [];

    const first = locks.run(["b", "a"], async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = locks.run(["a", "b"], async () => { events.push("second"); });

    await tick();
    expect(events).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);

    await expect(locks.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(locks.run("a", async () => "released")).resolves.toBe("released");
  });
});
