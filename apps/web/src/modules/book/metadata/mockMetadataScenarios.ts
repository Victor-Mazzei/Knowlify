import type {
  MetadataCandidate,
  MetadataLookupError,
  MetadataLookupErrorCode,
  MetadataLookupReason,
} from "../types";
import { MOCK_METADATA_CANDIDATES } from "./mockMetadataCandidates";

export const MOCK_METADATA_SCENARIOS = [
  "service-disabled",
  "key-rejected",
  "referrer-or-ip-blocked",
  "forbidden",
  "key-unreadable",
  "rate-limited",
  "network",
  "blocked-destination",
  "timeout",
  "upstream-error",
  "not-found",
  "http-error",
  "bad-response",
  "empty",
] as const;

export type MockMetadataScenario = (typeof MOCK_METADATA_SCENARIOS)[number];

export type MockSearchScenario = { errors: MetadataLookupError[]; candidates: MetadataCandidate[] };

const failure = (
  reason: MetadataLookupReason,
  code: MetadataLookupErrorCode = "unavailable",
): MetadataLookupError => ({ source: "googlebooks", code, reason });

const OPEN_LIBRARY_CANDIDATES = MOCK_METADATA_CANDIDATES.filter(
  (candidate) => candidate.source === "openlibrary",
);

const SEARCH_SCENARIOS: Record<MockMetadataScenario, MockSearchScenario> = {
  "service-disabled": { errors: [failure("service_disabled")], candidates: [] },
  "key-rejected": { errors: [failure("key_rejected")], candidates: [] },
  "referrer-or-ip-blocked": { errors: [failure("referrer_or_ip_blocked")], candidates: [] },
  "forbidden": { errors: [failure("forbidden")], candidates: [] },
  "key-unreadable": { errors: [failure("key_unreadable")], candidates: [] },
  "rate-limited": {
    errors: [failure("rate_limited", "rate_limited")],
    candidates: OPEN_LIBRARY_CANDIDATES,
  },
  "network": { errors: [failure("network")], candidates: [] },
  "blocked-destination": { errors: [failure("blocked_destination")], candidates: [] },
  "timeout": { errors: [failure("timeout", "timeout")], candidates: [] },
  "upstream-error": { errors: [failure("upstream_error", "rate_limited")], candidates: [] },
  "not-found": { errors: [failure("not_found")], candidates: [] },
  "http-error": { errors: [failure("http_error")], candidates: [] },
  "bad-response": { errors: [failure("bad_response")], candidates: [] },
  "empty": { errors: [], candidates: [] },
};

export function mockMetadataScenario(value: string | null): MockMetadataScenario | null {
  return MOCK_METADATA_SCENARIOS.find((scenario) => scenario === value) ?? null;
}

/** `?mock=metadata-search&scenario=key-rejected` drives the dialog in dev previews. */
function scenarioFromLocation(): MockMetadataScenario | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const query = new URLSearchParams(window.location.search);
  return query.get("mock") === "metadata-search" ? mockMetadataScenario(query.get("scenario")) : null;
}

/** Explicit option first; otherwise the dev URL; otherwise the default mock response. */
export function searchScenarioFor(selected?: MockMetadataScenario): MockSearchScenario | null {
  const name = selected ?? scenarioFromLocation();
  return name ? SEARCH_SCENARIOS[name] : null;
}
