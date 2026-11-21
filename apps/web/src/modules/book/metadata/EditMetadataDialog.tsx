import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ApiFn } from "../../../components/dialogs";
import { useConfirm, useDialogKeys } from "../../../components/dialogs";
import { formatError } from "../../../services/api";
import type { BookDetail, MetadataDialogProps, MetadataField } from "../types";
import { metadataErrorField, resetBookMetadata, updateBookMetadata } from "../metadataApi";
import { CoverEditor } from "./CoverEditor";
import { MetadataField as Field } from "./MetadataField";
import {
  draftFromMetadata,
  FIELD_LABELS,
  fieldOrigin,
  originLabel,
  patchFromDraft,
  validateDraft,
  type DraftField,
  type FieldErrors,
  type MetadataDraft,
} from "./metadataFields";
import { useMetadataApi } from "./useMetadataApi";
import "./metadata.css";

export type EditMetadataDialogProps = MetadataDialogProps & { api?: ApiFn };

const asDraftField = (field: MetadataField | "seriesIndex" | null): DraftField | null => {
  if (!field || field === "cover") return null;
  return field as DraftField;
};

export function EditMetadataDialog({ book, onClose, onSaved, api: apiOverride }: EditMetadataDialogProps) {
  const api = useMetadataApi(apiOverride);
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const [current, setCurrent] = useState(book);
  const [draft, setDraft] = useState<MetadataDraft>(() => draftFromMetadata(book.metadata));
  const [cleared, setCleared] = useState<Set<MetadataField>>(() => new Set());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const { ask, dialog } = useConfirm();

  const close = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);
  useDialogKeys(ref, close);

  useEffect(() => {
    titleRef.current?.focus();
    const previous = opener.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const patch = patchFromDraft(draft, current.metadata, cleared);
  const dirty = Object.keys(patch).some((key) => key !== "source");
  const hasOverrides = Object.values(current.metadata.overridden).some(Boolean);

  const focusFirstProblem = () => {
    window.requestAnimationFrame(() => {
      const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      (invalid ?? titleRef.current)?.focus();
    });
  };

  function update(field: DraftField, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setCleared((previous) => {
      if (!previous.has(field as MetadataField)) return previous;
      const next = new Set(previous);
      next.delete(field as MetadataField);
      return next;
    });
    setErrors((previous) => {
      if (!previous[field] && !previous.form) return previous;
      const next = { ...previous };
      delete next[field];
      delete next.form;
      return next;
    });
    setGeneral("");
    setNotice("");
  }

  function resetField(field: DraftField) {
    setDraft((previous) => {
      const fileValue = field === "title" ? current.metadata.file.title : field === "author" ? current.metadata.file.author : "";
      return { ...previous, [field]: fileValue, ...(field === "series" ? { seriesIndex: "" } : {}) };
    });
    if (field !== "seriesIndex") {
      setCleared((previous) => new Set(previous).add(field as MetadataField));
    }
    setErrors((previous) => {
      const next = { ...previous };
      delete next[field];
      delete next.form;
      return next;
    });
  }

  function save() {
    const validation = validateDraft(draft, new Date(), cleared);
    if (Object.keys(validation).length > 0) {
      setErrors({ ...validation, form: "Check the highlighted fields." });
      focusFirstProblem();
      return;
    }
    if (!dirty) {
      setGeneral("No changes to save.");
      return;
    }
    setSaving(true);
    setErrors({});
    setGeneral("");
    setNotice("");
    void updateBookMetadata(api, current.id, patch)
      .then((next) => {
        setCurrent(next);
        setDraft(draftFromMetadata(next.metadata));
        setCleared(new Set());
        setNotice("Metadata saved.");
        onSaved(next);
      })
      .catch((reason: unknown) => {
        const field = asDraftField(metadataErrorField(reason));
        if (field) {
          setErrors({ [field]: reason instanceof Error ? reason.message : "Invalid value." });
          focusFirstProblem();
        } else {
          setGeneral(formatError(reason));
        }
      })
      .finally(() => setSaving(false));
  }

  async function resetAll() {
    const ok = await ask({
      title: "Reset to file metadata?",
      message:
        "Every edit, including a custom cover, will be removed. Title and author return to the values extracted from the file; other fields are cleared.",
      confirmLabel: "Reset metadata",
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    setErrors({});
    setGeneral("");
    try {
      const next = await resetBookMetadata(api, current.id);
      setCurrent(next);
      setDraft(draftFromMetadata(next.metadata));
      setCleared(new Set());
      setNotice("Metadata reset to the file.");
      onSaved(next);
    } catch (reason) {
      setGeneral(formatError(reason));
    } finally {
      setSaving(false);
    }
  }

  const coverSaved = (next: BookDetail) => {
    setCurrent(next);
    setNotice("Cover updated.");
    onSaved(next);
  };

  const input = (field: DraftField, options: { maxLength?: number; placeholder?: string; inputMode?: "numeric" | "decimal" } = {}) => ({
    id: `edit-metadata-${field}`,
    value: draft[field],
    maxLength: options.maxLength,
    placeholder: options.placeholder,
    inputMode: options.inputMode,
    autoComplete: "off",
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? `edit-metadata-${field}-error` : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement>) => update(field, event.target.value),
  });
  const origin = (name: DraftField) => originLabel(fieldOrigin(name, draft, current.metadata, cleared));
  const field = (name: DraftField, options?: Parameters<typeof input>[1]) => (
    <Field
      id={`edit-metadata-${name}`}
      label={FIELD_LABELS[name]}
      origin={fieldOrigin(name, draft, current.metadata, cleared)}
      error={errors[name]}
      onReset={origin(name) === "Edited" ? () => resetField(name) : null}
      hint={
        name === "description" ? `${draft.description.length} / 5000` : name === "isbn10" ? "10 characters, last may be X" : name === "isbn13" ? "13 digits" : name === "language" ? "For example en or pt-BR" : undefined
      }
      wide={name === "title" || name === "author" || name === "description"}
    >
      {name === "description" ? (
        <textarea
          {...input(name, { maxLength: 5000 })}
          rows={4}
          onChange={(event) => update(name, event.target.value)}
        />
      ) : (
        <input {...input(name, options)} ref={name === "title" ? titleRef : undefined} type="text" />
      )}
    </Field>
  );

  return (
    <div className="dialog-backdrop centered" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={ref} className="confirm-dialog metadata-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-metadata-heading">
        <header className="metadata-header">
          <div>
            <h2 id="edit-metadata-heading">Edit metadata</h2>
            <p className="metadata-subtitle" title={current.title}>{current.title}</p>
          </div>
          <button type="button" className="ghost metadata-close" aria-label="Close" onClick={close} disabled={saving}>
            ×
          </button>
        </header>
        <form className="metadata-form" noValidate onSubmit={(event) => { event.preventDefault(); save(); }}>
          <div className="metadata-layout">
            <CoverEditor api={api} book={current} custom={current.metadata.overridden.cover} onSaved={coverSaved} />
            <div className="metadata-fields">
              <fieldset className="metadata-group">
                <legend>Book</legend>
                {field("title", { maxLength: 300 })}
                {field("author", { maxLength: 200 })}
                {field("description")}
              </fieldset>
              <fieldset className="metadata-group">
                <legend>Publishing</legend>
                {field("isbn10", { maxLength: 17 })}
                {field("isbn13", { maxLength: 17 })}
                {field("year", { maxLength: 4, inputMode: "numeric", placeholder: "2005" })}
                {field("publisher", { maxLength: 200 })}
                {field("language", { maxLength: 20, placeholder: "en" })}
                {field("series", { maxLength: 200 })}
                {field("seriesIndex", { maxLength: 7, inputMode: "decimal", placeholder: "1" })}
              </fieldset>
            </div>
          </div>
          {errors.form && (
            <p className="error metadata-feedback" role="alert">
              {errors.form}
            </p>
          )}
          {general && (
            <p className="error metadata-feedback" role="alert">
              {general}
            </p>
          )}
          {notice && (
            <p className="notice metadata-feedback" role="status">
              {notice}
            </p>
          )}
          <div className="metadata-actions">
            <button type="button" className="ghost metadata-reset-all" onClick={() => void resetAll()} disabled={!hasOverrides || saving}>
              Reset to file metadata
            </button>
            <span className="metadata-actions-spacer" />
            <button type="button" className="ghost bordered" onClick={close} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
        {dialog}
      </div>
    </div>
  );
}
