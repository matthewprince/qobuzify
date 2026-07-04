import { useState } from "react";
import type { Theme } from "./themes";

export default function ThemeCard({ theme }: { theme: Theme }) {
  const [copied, setCopied] = useState(false);
  const cmd = `qobuzify apply ${theme.slug}`;
  const { bg, surface, accent, text } = theme.preview;

  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="card theme-card">
      {/* a mini Qobuz-style player rendered in the theme's own colors */}
      <div className="preview" style={{ background: bg }}>
        <div className="preview-art" style={{ background: surface }} />
        <div className="preview-lines">
          <span className="line" style={{ background: text }} />
          <span className="line short" style={{ background: text, opacity: 0.5 }} />
          <div className="preview-bar" style={{ background: surface }}>
            <span style={{ background: accent }} />
          </div>
        </div>
        <span className="preview-play" style={{ background: accent }} />
      </div>

      <div className="theme-meta">
        <div className="theme-head">
          <h3>{theme.name}</h3>
          <span className="swatch" style={{ background: accent }} />
        </div>
        <p>{theme.description}</p>
        <button className="cmd" onClick={copy} title="Copy install command">
          <code>{cmd}</code>
          <span className="copy">{copied ? "copied" : "copy"}</span>
        </button>
      </div>
    </div>
  );
}
