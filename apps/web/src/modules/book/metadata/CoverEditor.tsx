import { useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../../components/dialogs";
import { useConfirm } from "../../../components/dialogs";
import { ApiError, formatError } from "../../../services/api";
import type { BookDetail } from "../types";
import { resetBookCover, uploadBookCover } from "../metadataApi";

const COVER_TYPES = ["image/jpeg", "image/png", "image/webp"];
const COVER_MAX_BYTES = 5 * 1024 * 1024;

const uploadProblem = (file: File): string | null => {
  if (!COVER_TYPES.includes(file.type)) return "Choose a JPEG, PNG or WebP image.";
  if (file.size === 0) return "The image is empty.";
  if (file.size > COVER_MAX_BYTES) return "The image must be 5 MB or smaller.";
  return null;
};

const uploadError = (reason: unknown): string => {
  if (reason instanceof ApiError) {
    if (reason.status === 413) return "The image must be 5 MB or smaller.";
    if (reason.status === 415) return "The server could not read that image. Use a JPEG, PNG or WebP file.";
    return reason.message;
  }
  return formatError(reason);
};

/**
 * Cover column of the edit form: current cover, an immediate upload with a local
 * preview, and removal of the custom cover back to the file's cover.
 */
export function CoverEditor({
  api,
  book,
  custom,
  onSaved,
}: {
  api: ApiFn;
  book: BookDetail;
  custom: boolean;
  onSaved: (book: BookDetail) => void;
}) {
  const [remote, setRemote] = useState("");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const { ask, dialog } = useConfirm();
  const request = useRef(0);

  useEffect(() => {
    let active = true;
    let url = "";
    if (!book.hasCover) {
      setRemote("");
      return;
    }
    const attempt = ++request.current;
    const bust = reload > 0 ? `?v=${Date.now()}` : book.coverRev != null ? `?v=${book.coverRev}` : "";
    void api(`/api/books/${encodeURIComponent(book.id)}/cover${bust}`)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!active || attempt !== request.current || !blob || typeof URL.createObjectURL !== "function") return;
        url = URL.createObjectURL(blob);
        setRemote(url);
      })
      .catch(() => {
        if (active && attempt === request.current) setRemote("");
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, book.id, book.coverRev, book.hasCover, reload]);

  useEffect(() => () => {
    if (local) URL.revokeObjectURL(local);
  }, [local]);

  async function choose(file: File | undefined) {
    if (!file) return;
    const problem = uploadProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    if (typeof URL.createObjectURL === "function") setLocal(URL.createObjectURL(file));
    setBusy(true);
    try {
      const updated = await uploadBookCover(api, book.id, file);
      setReload((value) => value + 1);
      onSaved(updated);
    } catch (reason) {
      setError(uploadError(reason));
      setLocal("");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await ask({
      title: "Remove custom cover?",
      message: "The book will use the cover extracted from its file.",
      confirmLabel: "Remove cover",
    });
    if (!ok) return;
    setError("");
    setBusy(true);
    try {
      const updated = await resetBookCover(api, book.id);
      setLocal("");
      setRemote("");
      setReload((value) => value + 1);
      onSaved(updated);
    } catch (reason) {
      setError(uploadError(reason));
    } finally {
      setBusy(false);
    }
  }

  const shown = local || remote;
  return (
    <section className="metadata-cover" aria-label="Cover" aria-busy={busy}>
      <h3>Cover</h3>
      <div className="metadata-cover-frame">
        {shown ? (
          <img src={shown} alt="" />
        ) : (
          <span className="metadata-cover-empty" aria-hidden="true">
            {book.format.toUpperCase()}
          </span>
        )}
      </div>
      <p className="metadata-cover-state">
        {custom ? "Custom cover" : book.hasCover ? "From file" : "No cover"}
      </p>
      <label className="metadata-cover-upload">
        Upload cover image
        <input
          className="visually-hidden"
          type="file"
          aria-label="Upload cover image"
          accept={COVER_TYPES.join(",")}
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void choose(file);
          }}
        />
      </label>
      <p className="metadata-hint">JPEG, PNG or WebP · up to 5 MB</p>
      {custom && (
        <button type="button" className="ghost bordered metadata-cover-remove" onClick={() => void remove()} disabled={busy}>
          Remove custom cover
        </button>
      )}
      {busy && (
        <p className="metadata-inline-status" role="status">
          Updating cover…
        </p>
      )}
      {error && (
        <p className="error metadata-cover-error" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </section>
  );
}
