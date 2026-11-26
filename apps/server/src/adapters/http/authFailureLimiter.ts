import { RateWindow } from "../RateWindow.js";
import { normalizePeerAddress } from "../../domain/network/PeerAddress.js";

/** Failed Basic/KOSync attempts allowed per peer inside one minute. */
export const AUTH_FAILURES_PER_MINUTE = 10;

/** Hard cap on tracked peers, so a peer-cycling client cannot grow the map without bound. */
export const MAX_TRACKED_PEERS = 4_096;

export interface LimiterVerdict {
  blocked: boolean;
  retryAfterSec: number;
}

/**
 * Failed Basic and KOSync attempts, keyed by the socket address. Enabled only with the LAN
 * guard: behind a reverse proxy without `trustProxy` every client shares one address and a
 * per-address limit would become a denial of service against the operator.
 */
export class AuthFailureLimiter {
  private readonly window = new RateWindow(AUTH_FAILURES_PER_MINUTE, 60_000, MAX_TRACKED_PEERS);

  private key(peer: string): string {
    return normalizePeerAddress(peer) ?? "unknown";
  }

  /** Tracked peers; exposed so tests can prove the map stays bounded. */
  get trackedPeers(): number {
    return this.window.size;
  }

  /** Verdict before the credential check, so a correct password does not clear the block. */
  blocked(peer: string, now = Date.now()): LimiterVerdict {
    const verdict = this.window.check(this.key(peer), now);
    return { blocked: !verdict.allowed, retryAfterSec: verdict.retryAfterSec };
  }

  recordFailure(peer: string, now = Date.now()): void {
    this.window.hit(this.key(peer), now);
  }
}
