import { useCallback, useEffect, useState } from "react";
import { formatError, useApi } from "../../services/api";
import type { Credentials } from "../../types";
import type { Article, Bookmark, Feed, NewsError } from "./types";

type ArticleResponse = {
  articles: Article[];
  errors: NewsError[];
};

type FeedInput = {
  kind: "topic" | "custom";
  query?: string;
  url?: string;
};

type FeedUpdate = {
  title?: string;
  enabled?: boolean;
};

export function useNews(credentials: Credentials, onLogout: () => void) {
  const api = useApi(credentials, onLogout);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [errors, setErrors] = useState<NewsError[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadFeeds = useCallback(async () => {
    const response = await api("/api/news/feeds");
    setFeeds(await response.json());
  }, [api]);

  const loadBookmarks = useCallback(async () => {
    const response = await api("/api/news/bookmarks");
    setBookmarks(await response.json());
  }, [api]);

  const loadArticles = useCallback(
    async (feedId?: string) => {
      setLoading(true);
      setError("");
      try {
        const query = feedId
          ? `?feedId=${encodeURIComponent(feedId)}&limit=50`
          : "?limit=50";
        const response = await api(`/api/news/articles${query}`);
        const result = (await response.json()) as ArticleResponse;
        setArticles(result.articles);
        setErrors(result.errors ?? []);
      } catch (value) {
        setError(formatError(value));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  const search = useCallback(
    async (query: string) => {
      setLoading(true);
      setError("");
      try {
        const response = await api(
          `/api/news/search?q=${encodeURIComponent(query)}&limit=50`,
        );
        const result = (await response.json()) as ArticleResponse;
        setArticles(result.articles);
        setErrors(result.errors ?? []);
      } catch (value) {
        setError(formatError(value));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  const addFeed = useCallback(
    async (input: FeedInput) => {
      await api("/api/news/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      await loadFeeds();
    },
    [api, loadFeeds],
  );

  const updateFeed = useCallback(
    async (id: string, update: FeedUpdate) => {
      await api(`/api/news/feeds/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      await loadFeeds();
    },
    [api, loadFeeds],
  );

  const removeFeed = useCallback(
    async (id: string) => {
      await api(`/api/news/feeds/${id}`, { method: "DELETE" });
      await loadFeeds();
    },
    [api, loadFeeds],
  );

  const save = useCallback(
    async (article: Article) => {
      await api("/api/news/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: article.title,
          link: article.link,
          source: article.source,
          summary: article.summary,
          publishedAt: article.publishedAt,
        }),
      });
      await loadBookmarks();
    },
    [api, loadBookmarks],
  );

  const removeBookmark = useCallback(
    async (id: string) => {
      await api(`/api/news/bookmarks/${id}`, { method: "DELETE" });
      await loadBookmarks();
    },
    [api, loadBookmarks],
  );

  useEffect(() => {
    void Promise.all([loadFeeds(), loadBookmarks()]).catch((value) => {
      setError(formatError(value));
    });
  }, [loadFeeds, loadBookmarks]);

  return {
    feeds,
    bookmarks,
    articles,
    errors,
    loading,
    error,
    loadArticles,
    loadBookmarks,
    search,
    addFeed,
    updateFeed,
    removeFeed,
    save,
    removeBookmark,
  };
}
