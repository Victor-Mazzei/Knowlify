import { describe, expect, it } from "vitest";
import type { MetadataLookupError, MetadataLookupReason } from "../types";
import {
  hasLookupTrouble,
  lookupKeyConfigured,
  metadataLookupMessage,
  mostActionableLookupError,
} from "./lookupMessages";

const problem = (
  reason: MetadataLookupReason | undefined,
  code: MetadataLookupError["code"] = "unavailable",
  source: MetadataLookupError["source"] = "googlebooks",
): MetadataLookupError => ({ source, code, ...(reason ? { reason } : {}) });

const EXPECTED: Array<[MetadataLookupReason, string]> = [
  [
    "service_disabled",
    "Google Books refused the request. Enable the Books API for the project that owns your API key.",
  ],
  ["key_rejected", "Google Books rejected the API key. Check the key in Settings > Metadata lookup."],
  [
    "referrer_or_ip_blocked",
    "The API key has restrictions that block server requests. Remove the HTTP referrer restriction or allow this server IP.",
  ],
  ["forbidden", "Google Books denied access with this key. Check its API restrictions in Google Cloud."],
  ["key_unreadable", "The saved API key cannot be read. Enter it again in Settings > Metadata lookup."],
  ["network", "The server could not reach Google Books. Check the server network and DNS."],
  ["timeout", "Google Books took too long to answer."],
  ["blocked_destination", "The request to Google Books was blocked by the server network policy."],
  ["upstream_error", "Google Books had a server error. Try again later."],
  ["not_found", "Google Books returned no match."],
  ["http_error", "Google Books could not be reached."],
  ["bad_response", "Google Books could not be reached."],
];

describe("metadataLookupMessage", () => {
  it.each(EXPECTED)("maps %s to an actionable sentence", (reason, text) => {
    expect(metadataLookupMessage(problem(reason)).text).toBe(text);
  });

  it("only suggests an API key when Google Books has none", () => {
    const limited = problem("rate_limited", "rate_limited");
    expect(metadataLookupMessage(limited, { keyConfigured: false })).toEqual({
      text: "Google Books is limiting requests. Try again in a minute, or add an API key in Settings.",
      link: { label: "Settings", to: "/settings/metadata" },
    });
    expect(metadataLookupMessage(limited, { keyConfigured: true })).toEqual({
      text: "Google Books is limiting requests. Try again in a minute.",
    });
    expect(metadataLookupMessage(problem("rate_limited", "rate_limited", "openlibrary"))).toEqual({
      text: "Open Library is limiting requests. Try again in a minute.",
    });
  });

  it("links only the settings-related key messages to /settings/metadata", () => {
    const linked = [
      metadataLookupMessage(problem("key_rejected")),
      metadataLookupMessage(problem("key_unreadable")),
    ];
    for (const message of linked) {
      expect(message.link).toEqual({ label: "Settings > Metadata lookup", to: "/settings/metadata" });
    }
    expect(metadataLookupMessage(problem("service_disabled")).link).toBeUndefined();
    expect(metadataLookupMessage(problem("network")).link).toBeUndefined();
  });

  it("falls back to the legacy code text when the reason is absent", () => {
    expect(metadataLookupMessage(problem(undefined, "rate_limited")).text).toBe(
      "Google Books hit its rate limit. Try again later.",
    );
    expect(metadataLookupMessage(problem(undefined, "timeout")).text).toBe(
      "Google Books took too long to answer.",
    );
    expect(metadataLookupMessage(problem(undefined, "unavailable")).text).toBe(
      "Google Books could not be reached.",
    );
  });

  it("names the provider without exposing provider text", () => {
    expect(metadataLookupMessage({ source: "openlibrary", code: "unavailable", reason: "network" }).text).toBe(
      "The server could not reach Open Library. Check the server network and DNS.",
    );
  });
});

describe("mostActionableLookupError", () => {
  it("prefers key/setup problems, then network, then rate limits, then generic failures", () => {
    const key = problem("key_rejected");
    const disabled = problem("service_disabled");
    const network = problem("network");
    const timeout = problem("timeout");
    const limited = problem("rate_limited", "rate_limited");
    expect(mostActionableLookupError([limited, timeout, disabled, network, key])).toBe(key);
    expect(mostActionableLookupError([limited, timeout, network])).toBe(network);
    expect(mostActionableLookupError([limited, timeout])).toBe(timeout);
    expect(mostActionableLookupError([limited, problem(undefined, "unavailable")])).toBe(limited);
    expect(mostActionableLookupError([])).toBeNull();
  });

  it("treats a not-found answer as harmless but still reportable", () => {
    expect(hasLookupTrouble([problem("not_found")])).toBe(false);
    expect(hasLookupTrouble([problem("not_found"), problem("network")])).toBe(true);
    expect(mostActionableLookupError([problem("not_found")])?.reason).toBe("not_found");
    expect(mostActionableLookupError([problem("not_found"), problem(undefined, "unavailable")])?.reason).toBeUndefined();
  });

  it("reads the configured key from the lookup status", () => {
    const status = {
      enabled: true,
      providers: [
        { id: "googlebooks" as const, keyConfigured: true },
        { id: "openlibrary" as const, keyConfigured: false },
      ],
    };
    expect(lookupKeyConfigured(status, "googlebooks")).toBe(true);
    expect(lookupKeyConfigured(status, "openlibrary")).toBe(false);
    expect(lookupKeyConfigured(null, "googlebooks")).toBe(false);
  });
});
