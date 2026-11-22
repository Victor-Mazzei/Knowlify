import type {
  MetadataLookupError,
  MetadataLookupErrorCode,
  MetadataLookupReason,
  MetadataLookupStatus,
} from "../types";
import { SOURCE_LABEL } from "./CandidateList";

const SETTINGS_PATH = "/settings/metadata" as const;
const SETTINGS_LINK = { label: "Settings > Metadata lookup", to: SETTINGS_PATH };
const SETTINGS_ONLY = { label: "Settings", to: SETTINGS_PATH };

export type LookupMessage = {
  /** Full sentence; `link.label` appears exactly once when there is an internal link. */
  text: string;
  link?: { label: string; to: typeof SETTINGS_PATH };
};

const message = (text: string, link?: LookupMessage["link"]): LookupMessage => ({ text, link });

const genericMessage = (problem: MetadataLookupError, provider: string): LookupMessage => {
  switch (problem.code) {
    case "rate_limited":
      return message(`${provider} hit its rate limit. Try again later.`);
    case "timeout":
      return message(`${provider} took too long to answer.`);
    case "unavailable":
      return message(`${provider} could not be reached.`);
  }
};

/**
 * One actionable sentence for a provider failure. Messages are static UI copy:
 * the provider's own error text is never displayed, only the stable reason.
 */
export function metadataLookupMessage(
  problem: MetadataLookupError,
  options: { keyConfigured?: boolean } = {},
): LookupMessage {
  const provider = SOURCE_LABEL[problem.source];
  switch (problem.reason) {
    case "service_disabled":
      return message(
        `${provider} refused the request. Enable the Books API for the project that owns your API key.`,
      );
    case "key_rejected":
      return message(
        `${provider} rejected the API key. Check the key in ${SETTINGS_LINK.label}.`,
        SETTINGS_LINK,
      );
    case "referrer_or_ip_blocked":
      return message(
        "The API key has restrictions that block server requests. Remove the HTTP referrer restriction or allow this server IP.",
      );
    case "forbidden":
      return message(
        `${provider} denied access with this key. Check its API restrictions in Google Cloud.`,
      );
    case "key_unreadable":
      return message(
        `The saved API key cannot be read. Enter it again in ${SETTINGS_LINK.label}.`,
        SETTINGS_LINK,
      );
    case "rate_limited":
      if (problem.source === "googlebooks" && !options.keyConfigured) {
        return message(
          `${provider} is limiting requests. Try again in a minute, or add an API key in ${SETTINGS_ONLY.label}.`,
          SETTINGS_ONLY,
        );
      }
      return message(`${provider} is limiting requests. Try again in a minute.`);
    case "network":
      return message(`The server could not reach ${provider}. Check the server network and DNS.`);
    case "timeout":
      return message(`${provider} took too long to answer.`);
    case "blocked_destination":
      return message(`The request to ${provider} was blocked by the server network policy.`);
    case "upstream_error":
      return message(`${provider} had a server error. Try again later.`);
    case "not_found":
      return message(`${provider} returned no match.`);
    case "bad_response":
    case "http_error":
    case undefined:
      return genericMessage(problem, provider);
  }
}

const REASON_PRIORITY: Record<MetadataLookupReason, number> = {
  key_rejected: 0,
  service_disabled: 1,
  referrer_or_ip_blocked: 2,
  forbidden: 3,
  key_unreadable: 4,
  network: 5,
  blocked_destination: 6,
  timeout: 7,
  upstream_error: 8,
  rate_limited: 9,
  http_error: 10,
  bad_response: 11,
  not_found: 13,
};

const CODE_PRIORITY: Record<MetadataLookupErrorCode, number> = {
  timeout: 7,
  rate_limited: 9,
  unavailable: 12,
};

const priorityOf = (problem: MetadataLookupError): number =>
  problem.reason ? REASON_PRIORITY[problem.reason] : CODE_PRIORITY[problem.code];

/** The failure worth explaining first when there are no candidates to show. */
export function mostActionableLookupError(errors: MetadataLookupError[]): MetadataLookupError | null {
  let best: MetadataLookupError | null = null;
  for (const problem of errors) {
    if (!best || priorityOf(problem) < priorityOf(best)) best = problem;
  }
  return best;
}

/** `not_found` is an answer, not a fault, so it does not justify the debug hint. */
export const hasLookupTrouble = (errors: MetadataLookupError[]): boolean =>
  errors.some((problem) => problem.reason !== "not_found");

export const lookupKeyConfigured = (
  status: MetadataLookupStatus | null,
  source: MetadataLookupError["source"],
): boolean => status?.providers.some((provider) => provider.id === source && provider.keyConfigured) ?? false;
