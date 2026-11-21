import type { Feed } from "./types";

type FeedBarProps = {
  feeds: Feed[];
  selected: string;
  saved: boolean;
  onSelect: (id: string) => void;
  onManage: () => void;
};

export function FeedBar({ feeds, selected, saved, onSelect, onManage }: FeedBarProps) {
  return (
    <div className="feed-bar" role="group" aria-label="News feeds">
      <button
        className={`feed-chip ${!selected && !saved ? "active" : ""}`}
        aria-pressed={!selected && !saved}
        onClick={() => onSelect("")}
      >
        All
      </button>
      <button
        className={`feed-chip ${saved ? "active" : ""}`}
        aria-pressed={saved}
        onClick={() => onSelect("saved")}
      >
        Saved
      </button>
      {feeds.map((feed) => (
        <button
          key={feed.id}
          disabled={!feed.enabled}
          title={!feed.enabled ? "off" : undefined}
          className={`feed-chip ${selected === feed.id ? "active" : ""}`}
          aria-pressed={selected === feed.id}
          onClick={() => onSelect(feed.id)}
        >
          {feed.title}
          {!feed.enabled && " · off"}
        </button>
      ))}
      <button className="ghost" onClick={onManage}>
        Manage feeds
      </button>
    </div>
  );
}
