import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Logo } from "../../components/Logo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { formatError, useApi } from "../../services/api";
import type { Book, Credentials, Progress } from "../../types";
import { ReaderBody } from "./ReaderBody";

export function Reader({
  credentials,
  onLogout,
}: {
  credentials: Credentials;
  onLogout: () => void;
}) {
  const { id = "" } = useParams(),
    navigate = useNavigate(),
    [search] = useSearchParams(),
    jump = search.get("at") ?? "",
    api = useApi(credentials, onLogout),
    [book, setBook] = useState<Book>(),
    [data, setData] = useState<ArrayBuffer>(),
    [progress, setProgress] = useState<Progress>({
      position: "",
      percentage: 0,
    }),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = (await (await api(`/api/books/${id}`)).json()) as Book;
        const file = await api(`/api/books/${id}/file`);
        const saved = await api(`/api/books/${id}/progress`)
          .then((response) => response.json())
          .catch(() => {
            // No saved progress yet; start from the beginning.
            return null;
          });
        if (!cancelled) {
          setBook(found);
          setData(await file.arrayBuffer());
          if (
            saved &&
            typeof saved.position === "string" &&
            Number.isFinite(saved.percentage)
          )
            setProgress({
              position: saved.position,
              percentage: Math.max(0, Math.min(1, saved.percentage)),
            });
        }
      } catch (e) {
        if (!cancelled) setError(formatError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, id]);
  return (
    <div className="reader">
      <header>
        <Link to="/" className="brand">
          <Logo size={20} />
          Knowlify
        </Link>
        <button className="back" onClick={() => navigate(-1)}>
          ← Library
        </button>
        <div className="header-actions">
          <ThemeToggle />
        </div>
      </header>
      {error ? (
        <div className="reader-message error" role="alert">
          {error}
        </div>
      ) : book && data ? (
        <ReaderBody book={book} data={data} progress={progress} jump={jump} api={api} onNewsAbout={(text) => navigate(`/news?q=${encodeURIComponent(text)}`)} />
      ) : (
        <div className="reader-loading">Preparing your reading room…</div>
      )}
    </div>
  );
}
