import type { ApiFn } from "../../components/dialogs";
import { useMetadataLookupStatus } from "./metadata/useMetadataLookupStatus";

export type MetadataCapability = {
  /** The server exposes the metadata routes (edit, cover, lookup). */
  available: boolean;
  /** Online lookup is turned on by the operator; manual editing still is. */
  lookupEnabled: boolean;
};

/**
 * `GET /api/metadata/status` is the capability probe for the metadata track: a 404
 * (older server) hides every metadata action; 403 or `enabled: false` keeps manual
 * editing but hides "Search online".
 */
export function useMetadataCapability(api: ApiFn): MetadataCapability {
  const { availability } = useMetadataLookupStatus(api);
  return {
    available: availability === "enabled" || availability === "disabled",
    lookupEnabled: availability === "enabled",
  };
}
