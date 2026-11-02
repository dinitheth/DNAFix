import type { CSSProperties } from "react";

/**
 * Material Symbols glyph — the same icon set the sample UI renders.
 * `name` is the ligature name, e.g. "grid_view", "play_arrow".
 */
export function Icon({
  name,
  size = 16,
  className = "",
  filled = false,
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  filled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={`material-symbols-outlined inline-flex shrink-0 select-none items-center justify-center leading-none ${filled ? "is-filled" : ""} ${className}`}
      style={{ fontSize: `${size}px`, width: `${size}px`, height: `${size}px`, ...style }}
    >
      {name}
    </span>
  );
}
