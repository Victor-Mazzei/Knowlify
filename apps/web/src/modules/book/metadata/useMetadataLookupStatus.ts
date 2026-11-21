import { useCallback, useEffect, useState } from "react";
import type { ApiFn } from "../../../components/dialogs";
import type { MetadataLookupStatus } from "../types";
import { getMetadataStatus, isMetadataLookupDisabled, isMetadataLookupUnsupported } from "../metadataApi";

export type LookupAvailability = "loading" | "enabled" | "disabled" | "unsupported" | "error";

export type LookupStatusState = {
  availability: LookupAvailability;
  status: MetadataLookupStatus | null;
  error: string;
  retry: () => void;
};

/**
 * `GET /api/metadata/status` with the three cases the UI distinguishes: enabled,
 * turned off by the operator, and a server without the route (404).
 */
export function useMetadataLookupStatus(api: ApiFn): LookupStatusState {
  const [availability, setAvailability] = useState<LookupAvailability>("loading");
  const [status, setStatus] = useState<MetadataLookupStatus | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setAvailability("loading");
    setError("");
    void getMetadataStatus(api)
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setAvailability(next.enabled ? "enabled" : "disabled");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (isMetadataLookupUnsupported(reason)) setAvailability("unsupported");
        else if (isMetadataLookupDisabled(reason)) setAvailability("disabled");
        else {
          setAvailability("error");
          setError(reason instanceof Error ? reason.message : "Could not check online lookup.");
        }
      });
    return () => {
      active = false;
    };
  }, [api, attempt]);

  return { availability, status, error, retry };
}
