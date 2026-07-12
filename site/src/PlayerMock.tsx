import type { CSSProperties } from "react";

// A realistic Qobuz-player-shaped mock that recolors from four theme tokens and nothing
// else. Every visual reads from --pm-* CSS variables (set on the root here, styled in
// styles.css), so switching themes is a pure variable swap with a CSS crossfade. No
// backdrop-filter anywhere (keeps it off the glass-stacking bug class). If `image` is
// set, the real screenshot fills the frame and the CSS mock sits under it as a blur-up
// placeholder; otherwise the CSS mock is the final render.
export type PlayerColors = { bg: string; surface: string; accent: string; text: string };

const TRACKS = [
  { t: "Nightfall", d: "3:58", on: true },
  { t: "Golden Hour", d: "4:12", on: false },
  { t: "Undertow", d: "3:21", on: false },
  { t: "Afterglow", d: "5:04", on: false },
];

export default function PlayerMock({
  colors,
  compact = false,
  image,
  label,
}: {
  colors: PlayerColors;
  compact?: boolean;
  image?: string;
  label?: string;
}) {
  const vars = {
    "--pm-bg": colors.bg,
    "--pm-surface": colors.surface,
    "--pm-accent": colors.accent,
    "--pm-text": colors.text,
  } as CSSProperties;

  return (
    <div
      className={"pm" + (compact ? " pm-compact" : "")}
      style={vars}
      role="img"
      aria-label={label || "Qobuz player mockup"}
    >
      <div className="pm-inner" aria-hidden="true">
        <div className="pm-top">
          <div className="pm-art">
            <span className="pm-art-glow" />
          </div>
          <div className="pm-now">
            <div className="pm-title" />
            <div className="pm-artist" />
            <div className="pm-badge">Hi-Res</div>
          </div>
        </div>

        <div className="pm-scrub">
          <span className="pm-scrub-fill" />
          <span className="pm-scrub-dot" />
        </div>

        <div className="pm-controls">
          <span className="pm-ico pm-prev" />
          <span className="pm-play">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
          </span>
          <span className="pm-ico pm-next" />
        </div>

        <div className="pm-list">
          {TRACKS.slice(0, compact ? 2 : 4).map((r, i) => (
            <div className={"pm-row" + (r.on ? " on" : "")} key={i}>
              <span className="pm-eq">
                <i /><i /><i />
              </span>
              <span className="pm-row-title" style={{ width: 42 + ((i * 13) % 34) + "%" }} />
              <span className="pm-row-dur">{r.d}</span>
            </div>
          ))}
        </div>
      </div>

      {image ? <img className="pm-shot" src={image} loading="lazy" alt="" aria-hidden="true" /> : null}
    </div>
  );
}
