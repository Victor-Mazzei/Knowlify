const NUMBERS = new Intl.NumberFormat("en-US");

/** Counts in the interface always use the same grouping and never go negative. */
export const formatCount = (value: number) => NUMBERS.format(Math.max(0, Math.trunc(value)));

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Accepts either a 0–1 fraction or an already rounded percentage. */
export function formatPercent(progress: number | null | undefined): number | null {
  if (typeof progress !== "number" || !Number.isFinite(progress)) return null;
  const percent = progress <= 1 ? progress * 100 : progress;
  return Math.max(0, Math.min(100, Math.round(percent)));
}
