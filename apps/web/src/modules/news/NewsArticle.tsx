import type { Article, Bookmark } from "./types";
import { relativeDate } from "./relativeDate";

type NewsArticleProps = {
  article: Article | Bookmark;
  saved: boolean;
  onToggleSave: () => void;
};

export function NewsArticle({ article, saved, onToggleSave }: NewsArticleProps) {
  return (
    <article className="news-article">
      {"imageUrl" in article && article.imageUrl && (
        <img src={article.imageUrl} alt="" loading="lazy" />
      )}
      <div className="news-article-body">
        <div className="news-meta">
          <span>{article.source}</span>
          <span>{relativeDate(article.publishedAt)}</span>
        </div>
        <h2>
          <a href={article.link} target="_blank" rel="noopener noreferrer">
            {article.title}
          </a>
        </h2>
        <p>{article.summary}</p>
        <button
          className="ghost news-save"
          aria-pressed={saved}
          aria-label={`${saved ? "Remove from saved" : "Save for later"}: ${article.title}`}
          onClick={onToggleSave}
        >
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </article>
  );
}
