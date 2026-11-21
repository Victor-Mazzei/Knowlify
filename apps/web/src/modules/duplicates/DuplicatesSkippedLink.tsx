import { Link } from "react-router-dom";
import { formatCount } from "./format";

/**
 * Header counter for the files a scan skipped as duplicates. It stays visible
 * until a later scan reports zero, so the review card is one click away.
 */
export function DuplicatesSkippedLink({ count }: { count: number }) {
  const label = `${formatCount(count)} ${count === 1 ? "duplicate" : "duplicates"} skipped`;
  return (
    <Link
      className="duplicates-skipped"
      to="/settings/duplicates"
      title="Review skipped duplicates in Settings"
      aria-label={`${label}. Review in Settings.`}
    >
      {label}
    </Link>
  );
}
