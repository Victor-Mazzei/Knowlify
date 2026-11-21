import { useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../../components/dialogs";
import { useDialogKeys } from "../../../components/dialogs";
import { ApiError, formatError } from "../../../services/api";
import type { BookDetail, MetadataCandidate, MetadataDialogProps } from "../types";
import {
  isMetadataLookupDisabled,
  isMetadataLookupUnsupported,
  searchBookMetadata,
  setBookCoverFromUrl,
  updateBookMetadata,
} from "../metadataApi";
import { isValidIsbn10, isValidIsbn13, normalizeIsbn, preferredIsbn } from "./isbn";
import {
  candidateKey,
  candidatePatch,
  candidateProblem,
  defaultCandidateFields,
  type CandidateField,
} from "./applyCandidate";
import { CandidateApplyPanel } from "./CandidateApplyPanel";
import { CandidateList, SOURCE_LABEL } from "./CandidateList";
import { FindSearchForm, type SearchMode } from "./FindSearchForm";
import { useMetadataApi } from "./useMetadataApi";
import { useMetadataLookupStatus } from "./useMetadataLookupStatus";
import "./metadata.css";

export type FindMetadataDialogProps = MetadataDialogProps & { api?: ApiFn };

const PROBLEM: Record<string, string> = {
  rate_limited: "hit its rate limit. Try again later.",
  timeout: "took too long to answer.",
  unavailable: "could not be reached.",
};

export function FindMetadataDialog({ book, onClose, onSaved, api: apiOverride }: FindMetadataDialogProps) {
  const api = useMetadataApi(apiOverride);
  const lookup = useMetadataLookupStatus(api);
  const ref = useRef<HTMLDivElement>(null);
  const isbnRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const firstIsbn = preferredIsbn(book.metadata);
  const [mode, setMode] = useState<SearchMode>(firstIsbn ? "isbn" : "title");
  const [isbn, setIsbn] = useState(firstIsbn?.value ?? "");
  const [title, setTitle] = useState(book.metadata.title);
  const [author, setAuthor] = useState(book.metadata.author);
  const [queryError, setQueryError] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [blocked, setBlocked] = useState("");
  const [current, setCurrent] = useState(book);
  const [result, setResult] = useState<Awaited<ReturnType<typeof searchBookMetadata>> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fields, setFields] = useState<Set<CandidateField>>(new Set());
  const [cover, setCover] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [notice, setNotice] = useState("");

  const close = () => {
    if (!applying) onClose();
  };
  useDialogKeys(ref, close);

  useEffect(() => {
    const previous = opener.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (lookup.availability !== "enabled" || blocked) return;
    (mode === "isbn" ? isbnRef : titleRef).current?.focus();
  }, [lookup.availability, mode, blocked]);

  const candidate = result?.candidates.find((item) => candidateKey(item) === selected) ?? null;
  const search = async () => {
    setQueryError("");
    setSearchError("");
    setApplyError("");
    setNotice("");
    if (mode === "isbn") {
      const value = normalizeIsbn(isbn);
      if (!isValidIsbn10(value) && !isValidIsbn13(value)) {
        setQueryError("Enter a valid ISBN-10 or ISBN-13, including the check digit.");
        return;
      }
    } else {
      if (!title.trim()) {
        setQueryError("Add a title to search.");
        return;
      }
      if (title.trim().length > 200 || author.trim().length > 200) {
        setQueryError("Title and author are limited to 200 characters.");
        return;
      }
    }
    setSearching(true);
    setResult(null);
    setSelected(null);
    try {
      const next = await searchBookMetadata(
        api,
        mode === "isbn" ? { isbn: normalizeIsbn(isbn) } : { title: title.trim(), author: author.trim() || undefined },
      );
      setResult(next);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 429) {
        setSearchError("Too many searches right now. Wait a minute and try again.");
      } else if (isMetadataLookupDisabled(reason)) {
        setBlocked("Online lookup is turned off on this server. You can still edit metadata by hand.");
      } else if (isMetadataLookupUnsupported(reason)) {
        setBlocked("This server does not support online metadata lookup. You can still edit metadata by hand.");
      } else {
        setSearchError(formatError(reason));
      }
    } finally {
      setSearching(false);
    }
  };

  const choose = (match: MetadataCandidate) => {
    setSelected(candidateKey(match));
    setFields(defaultCandidateFields(match));
    setCover(false);
    setApplyError("");
    setNotice("");
  };

  const toggleField = (field: CandidateField) => {
    setFields((previous) => {
      const next = new Set(previous);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const apply = async () => {
    if (!candidate || applying) return;
    for (const field of fields) {
      const problem = candidateProblem(candidate, field);
      if (problem) {
        setApplyError(problem);
        return;
      }
    }
    setApplying(true);
    setApplyError("");
    setNotice("");
    let next = current;
    try {
      if (fields.size > 0) next = await updateBookMetadata(api, current.id, candidatePatch(candidate, fields));
      if (cover && candidate.coverUrl) {
        try {
          next = await setBookCoverFromUrl(api, current.id, candidate.coverUrl);
        } catch (reason) {
          setCurrent(next);
          onSaved(next);
          setApplyError(`Metadata applied, but the cover could not be downloaded. ${formatError(reason)}`);
          return;
        }
      }
      setCurrent(next);
      onSaved(next);
      setNotice(cover && candidate.coverUrl ? "Metadata and cover applied." : "Metadata applied.");
    } catch (reason) {
      setApplyError(formatError(reason));
    } finally {
      setApplying(false);
    }
  };

  const providers = result?.candidates.length
    ? [...new Set(result.candidates.map((item) => SOURCE_LABEL[item.source]))].join(" and ")
    : "";

  return (
    <div className="dialog-backdrop centered" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={ref} className="confirm-dialog metadata-dialog metadata-find" role="dialog" aria-modal="true" aria-labelledby="find-metadata-heading">
        <header className="metadata-header">
          <div>
            <h2 id="find-metadata-heading">Find metadata</h2>
            <p className="metadata-subtitle" title={current.title}>{current.title}</p>
          </div>
          <button type="button" className="ghost metadata-close" aria-label="Close" onClick={close} disabled={applying}>
            ×
          </button>
        </header>

        {lookup.availability === "loading" && (
          <p className="metadata-inline-status" role="status">Checking online lookup…</p>
        )}
        {lookup.availability === "error" && (
          <div className="error metadata-feedback" role="alert">
            <span>{lookup.error}</span>
            <button type="button" className="ghost bordered" onClick={lookup.retry}>Try again</button>
          </div>
        )}
        {(lookup.availability === "disabled" || blocked) && (
          <p className="notice metadata-feedback">
            {blocked || "Online lookup is turned off on this server. You can still edit metadata by hand."}
          </p>
        )}
        {lookup.availability === "unsupported" && (
          <p className="notice metadata-feedback">
            This server does not support online metadata lookup. You can still edit metadata by hand.
          </p>
        )}

        {lookup.availability === "enabled" && !blocked && (
          <FindSearchForm
            mode={mode}
            onMode={setMode}
            isbn={isbn}
            title={title}
            author={author}
            isbnRef={isbnRef}
            titleRef={titleRef}
            queryError={queryError}
            searching={searching}
            applying={applying}
            onIsbn={(value) => { setIsbn(value); setQueryError(""); }}
            onTitle={(value) => { setTitle(value); setQueryError(""); }}
            onAuthor={(value) => { setAuthor(value); setQueryError(""); }}
            onSubmit={() => void search()}
          />
        )}

        {searching && <p className="metadata-inline-status" role="status">Searching Open Library…</p>}
        {searchError && <p className="error metadata-feedback" role="alert">{searchError}</p>}
        {result && (
          <div className="metadata-results">
            <p className="metadata-results-count" role="status" aria-live="polite">
              {result.candidates.length === 0
                ? "No matches from the providers."
                : `${result.candidates.length} ${result.candidates.length === 1 ? "match" : "matches"} from ${providers}.`}
            </p>
            {result.errors.length > 0 && (
              <ul className="metadata-provider-notes" aria-label="Provider problems">
                {result.errors.map((problem) => (
                  <li key={`${problem.source}:${problem.code}`}>
                    {SOURCE_LABEL[problem.source]} {PROBLEM[problem.code] ?? "is unavailable."}
                  </li>
                ))}
              </ul>
            )}
            {result.candidates.length === 0 ? (
              <p className="metadata-empty">Check the ISBN or try a shorter title.</p>
            ) : (
              <CandidateList candidates={result.candidates} selected={selected} disabled={applying} onSelect={choose} />
            )}
            {candidate && (
              <CandidateApplyPanel
                candidate={candidate}
                current={current.metadata}
                fields={fields}
                cover={cover}
                applying={applying}
                onToggle={toggleField}
                onCover={setCover}
                onApply={() => void apply()}
              />
            )}
          </div>
        )}

        {applyError && <p className="error metadata-feedback" role="alert">{applyError}</p>}
        {notice && <p className="notice metadata-feedback" role="status">{notice}</p>}

        <div className="metadata-actions">
          <span className="metadata-actions-spacer" />
          <button type="button" className="ghost bordered" onClick={close} disabled={applying}>Close</button>
        </div>
      </div>
    </div>
  );
}
