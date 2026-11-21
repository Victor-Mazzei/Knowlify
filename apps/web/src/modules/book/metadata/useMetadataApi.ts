import { useMemo, useState } from "react";
import type { ApiFn } from "../../../components/dialogs";
import { clearCredentials, readCredentials, useApi } from "../../../services/api";
import type { Credentials } from "../../../types";

const ANONYMOUS: Credentials = { user: "", pass: "" };

/**
 * The dialogs own their data calls but the details page may already have an `ApiFn`.
 * When it passes one, dialogs reuse it; otherwise they build the session API from the
 * stored credentials so the scaffold props keep working on their own.
 */
export function useMetadataApi(override?: ApiFn): ApiFn {
  const [credentials] = useState<Credentials | null>(readCredentials);
  const unauthorized = () => {
    clearCredentials();
    window.location.reload();
  };
  const live = useApi(credentials ?? ANONYMOUS, unauthorized);
  return useMemo(() => override ?? live, [override, live]);
}
