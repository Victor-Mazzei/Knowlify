import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthFailureLimiter, MAX_TRACKED_PEERS } from "../src/adapters/http/authFailureLimiter.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Distinct RFC 1918 addresses, so every one is a private peer the guard accepts. */
const privatePeer = (index: number): string =>
  `10.${(index >> 16) & 0xff}.${(index >> 8) & 0xff}.${index & 0xff}`;

describe("bounded authentication failure limiter", () => {
  it("keeps the map bounded and fails closed when every slot is live", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const limiter = new AuthFailureLimiter();

    for (let index = 0; index < 10_000; index += 1) limiter.recordFailure(privatePeer(index));

    expect(limiter.trackedPeers).toBe(MAX_TRACKED_PEERS);
    // With every slot live, a brand-new peer is refused instead of being let through
    // without being counted (fail closed).
    const refused = limiter.blocked(privatePeer(20_000));
    expect(refused.blocked).toBe(true);
    expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(limiter.trackedPeers).toBe(MAX_TRACKED_PEERS);
  });

  it("discards expired entries and resumes tracking after the window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const limiter = new AuthFailureLimiter();
    for (let index = 0; index < 10_000; index += 1) limiter.recordFailure(privatePeer(index));

    vi.setSystemTime(new Date("2026-03-01T10:01:01Z"));
    const fresh = privatePeer(30_000);
    expect(limiter.blocked(fresh).blocked).toBe(false);
    expect(limiter.trackedPeers).toBe(0);
    limiter.recordFailure(fresh);
    expect(limiter.trackedPeers).toBe(1);
  });

  it("still blocks a tracked peer and recovers after the window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const limiter = new AuthFailureLimiter();
    const peer = "192.168.1.20";
    for (let failure = 0; failure < 10; failure += 1) limiter.recordFailure(peer);
    expect(limiter.blocked(peer).blocked).toBe(true);
    expect(limiter.trackedPeers).toBe(1);

    vi.setSystemTime(new Date("2026-03-01T10:01:01Z"));
    expect(limiter.blocked(peer).blocked).toBe(false);
    expect(limiter.trackedPeers).toBe(0);
  });
});
