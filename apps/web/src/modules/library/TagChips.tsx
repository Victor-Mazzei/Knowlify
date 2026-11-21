import type { TagWithCount } from "../../types";
import { tagColorClass } from "../tags/tagColors";

export function tagsForBook(tagIds: string[] | undefined, tags: TagWithCount[]): TagWithCount[] {
  if (!tagIds || tagIds.length === 0) return [];
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  return tagIds.map((id) => byId.get(id)).filter((tag): tag is TagWithCount => tag !== undefined);
}

const MAX_DOTS = 2;
const MAX_CHIPS = 2;

/** Two color dots plus a count keep the card height untouched. */
export function CardTagDots({ tags }: { tags: TagWithCount[] }) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, MAX_DOTS);
  const extra = tags.length - shown.length;
  const names = tags.map((tag) => tag.name).join(", ");
  return (
    <span className="card-tags" role="img" aria-label={`Tags: ${names}`} title={names}>
      {shown.map((tag) => (
        <span key={tag.id} className={`tag-dot ${tagColorClass(tag.color)}`} aria-hidden="true" />
      ))}
      {extra > 0 && (
        <span className="tag-more" aria-hidden="true">
          +{extra}
        </span>
      )}
    </span>
  );
}

export function TableTags({ tags }: { tags: TagWithCount[] }) {
  if (tags.length === 0) return <span className="muted">—</span>;
  const shown = tags.slice(0, MAX_CHIPS);
  const extra = tags.length - shown.length;
  return (
    <span className="table-tags">
      {shown.map((tag) => (
        <span key={tag.id} className={`tag-chip ${tagColorClass(tag.color)}`} title={tag.name}>
          {tag.name}
        </span>
      ))}
      {extra > 0 && (
        <span className="tag-more" aria-label={`${extra} more tags`}>
          +{extra}
        </span>
      )}
    </span>
  );
}
