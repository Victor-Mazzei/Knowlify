import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAutoDismiss } from "../../components/useAutoDismiss";
import { formatError } from "../../services/api";
import type { Credentials } from "../../types";
import { FeedBar } from "./FeedBar";
import { FeedsDialog } from "./FeedsDialog";
import { NewsArticle } from "./NewsArticle";
import { useNews } from "./useNews";

export function NewsPage({ credentials, onLogout }: { credentials: Credentials; onLogout: () => void }) {
  const news = useNews(credentials, onLogout);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [selected, setSelected] = useState("");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [dialog, setDialog] = useState(false);
  const [searching, setSearching] = useState(Boolean(params.get("q")));
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  useAutoDismiss(notice, setNotice);
  const savedLinks = new Set(news.bookmarks.map((bookmark) => bookmark.link));
  const followed = news.feeds.some(
    (feed) => feed.kind === "topic" && feed.query?.toLowerCase() === query.trim().toLowerCase(),
  );

  useEffect(() => {
    const value = params.get("q")?.trim() ?? "";
    setQuery(value);
    setSearching(Boolean(value));
    if (value) {
      void news.search(value);
    } else if (!selectedRef.current) {
      void news.loadArticles();
    }
  }, [params, news.search, news.loadArticles]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = query.trim();
    setNotice("");
    setActionError("");
    if (value) setParams({ q: value }, { replace: true });
  }

  function clearSearch() {
    setQuery("");
    setSearching(false);
    setSelected("");
    setParams({}, { replace: true });
  }

  function selectFeed(id: string) {
    setParams({}, { replace: true });
    setQuery("");
    setSearching(false);
    setSelected(id);
    setActionError("");
    setNotice("");
    if (id === "saved") {
      void news.loadBookmarks();
    } else {
      void news.loadArticles(id || undefined);
    }
  }

  async function followTopic() {
    const value = query.trim();
    if (!value || followed) return;
    setActionError("");
    setNotice("");
    try {
      await news.addFeed({ kind: "topic", query: value });
      setNotice(`Following “${value}”.`);
    } catch (error) {
      setActionError(formatError(error));
    }
  }

  const visible = selected === "saved" ? news.bookmarks : news.articles;

  return (
    <>
      <main className="library news-page">
        <section className="intro">
          <p className="eyebrow">Stay curious</p>
          <h1>News</h1>
          <p className="lede">Follow the ideas you are reading about, without leaving your library.</p>
        </section>
        <form className="news-search" onSubmit={submit}>
          <input
            aria-label="Search news"
            placeholder="Search news about…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="primary">Search</button>
          {searching && <button type="button" className="ghost" onClick={clearSearch}>Clear</button>}
          {searching && query.trim() && (
            <button type="button" className="ghost bordered" disabled={followed} onClick={() => void followTopic()}>
              {followed ? "Following" : "Follow topic"}
            </button>
          )}
        </form>
        {actionError && <div className="error" role="alert">{actionError}</div>}
        {notice && <div className="notice" role="status">{notice}</div>}
        <FeedBar
          feeds={news.feeds}
          selected={selected}
          saved={selected === "saved"}
          onSelect={selectFeed}
          onManage={() => setDialog(true)}
        />
        {news.errors.map((item) => (
          <div className="news-alert" role="alert" key={item.feedId}>
            {item.message}
          </div>
        ))}
        {news.error && <div className="error" role="alert">{news.error}</div>}
        {news.loading ? (
          <p className="muted loading">Loading stories…</p>
        ) : visible.length === 0 ? (
          <div className="empty">
            <strong>{searching ? "No stories found." : selected === "saved" ? "No saved stories." : "Your news feed is empty."}</strong>
            <span>{searching ? "Try a broader topic." : "Search for a topic or follow a feed to get started."}</span>
          </div>
        ) : (
          <div className="news-list">
            {visible.map((article) => {
              const bookmark = news.bookmarks.find((item) => item.link === article.link);
              const saved = savedLinks.has(article.link);
              return (
                <NewsArticle
                  key={article.id}
                  article={article}
                  saved={saved}
                  onToggleSave={() => {
                    if (bookmark) void news.removeBookmark(bookmark.id);
                    else if ("feedId" in article) void news.save(article);
                  }}
                />
              );
            })}
          </div>
        )}
        {dialog && (
          <FeedsDialog
            feeds={news.feeds}
            onAdd={(url) => news.addFeed({ kind: "custom", url })}
            onUpdate={news.updateFeed}
            onRemove={async (id) => {
              await news.removeFeed(id);
              if (selected === id) selectFeed("");
            }}
            onClose={() => setDialog(false)}
          />
        )}
      </main>
    </>
  );
}
