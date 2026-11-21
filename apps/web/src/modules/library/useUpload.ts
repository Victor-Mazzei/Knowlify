import { useCallback, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, formatError } from "../../services/api";

/** Canonical book reported by the server when a file is already in the library. */
export type DuplicateUpload = { id: string; title: string };

async function throwUploadFailure(response: Response): Promise<never> {
  let message = `Request failed (${response.status})`;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      message = body.message;
    }
  } catch {
    /* keep the status fallback */
  }
  throw new ApiError(response.status, message);
}

/** `duplicateOf` only exists on servers that deduplicate uploads (200 instead of 201). */
function readDuplicate(body: unknown): DuplicateUpload | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const id = record.duplicateOf;
  if (typeof id !== "string" || id === "") return null;
  return { id, title: typeof record.title === "string" ? record.title : "" };
}

export function useUpload(api: ApiFn, onUploaded: (file: File) => Promise<void>, onError: (message: string) => void) {
  const [uploading, setUploading] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateUpload | null>(null);
  const dismissDuplicate = useCallback(() => setDuplicate(null), []);

  async function upload(file: File) {
    if (!/\.(pdf|epub)$/i.test(file.name)) {
      onError("Only PDF and EPUB files are supported.");
      return;
    }
    setUploading(true);
    setDuplicate(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const response = await api("/api/books", { method: "POST", body: form });
      // `useApi` already throws for non-2xx; the check keeps injected APIs behaving the same.
      if (!response.ok) await throwUploadFailure(response);
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A successful upload with no JSON body still belongs to the normal path.
      }
      const found = readDuplicate(body);
      if (found) {
        setDuplicate(found);
        return;
      }
      await onUploaded(file);
    } catch (e) {
      onError(formatError(e));
    } finally {
      setUploading(false);
    }
  }

  return { uploading, upload, duplicate, dismissDuplicate };
}
