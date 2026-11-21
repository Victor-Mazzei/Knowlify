import "../styles/brand.css";

const MARK_PATHS = [
  "M11.5 14H21.5V33.5L29 26.5L34.5 27.7L39.8 30.6L31.2 38.5L47.5 54H33.1L21.6 42.5V54H11.5Z",
  "M28 11Q34 12 39.5 17.5L40 29.5Q34 27 28 24.5Z",
  "M53 11Q45 12 41 18V29.5Q47 26 53.5 23.5Z",
] as const;

export type LogoVariant = "default" | "mono";

export type LogoProps = {
  /** Rendered width and height in pixels. */
  size?: number;
  /** `default` uses the accent tile; `mono` is a bare mark in `currentColor`. */
  variant?: LogoVariant;
  /** Accessible name. Omit when the mark is decorative (the default). */
  label?: string;
  className?: string;
};

/**
 * Brand mark: a K monogram whose upper arm carries an open book. Kept inline so
 * it follows the theme tokens; the files under assets/brand are the icon sources.
 */
export function Logo({ size = 24, variant = "default", label, className }: LogoProps) {
  const classes = ["logo", variant === "mono" ? "logo--mono" : "", className]
    .filter(Boolean)
    .join(" ");
  const labelled = Boolean(label);
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? label : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      {variant === "default" && <rect width="64" height="64" rx="14" fill="var(--accent)" />}
      <g fill={variant === "mono" ? "currentColor" : "var(--on-accent)"}>
        {MARK_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
