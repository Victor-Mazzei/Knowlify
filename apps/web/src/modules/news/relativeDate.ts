export function relativeDate(value?: string, now = Date.now()): string {
  if (!value) return "Date unknown";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Date unknown";

  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;

  return new Date(time).toLocaleDateString();
}
