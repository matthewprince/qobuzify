import type { Theme } from "./themes";
import PlayerMock from "./PlayerMock";

// A gallery card: the same player mock, small, rendered in this theme's colors, plus its
// name, one-line description, and accent swatch. Pure preview - no CLI command (themes
// switch live from the in-app Marketplace, so a "qobuzify apply" command here would be
// both broken for a visitor and off-message).
export default function ThemeCard({ theme }: { theme: Theme }) {
  return (
    <div className="theme-card">
      <div className="theme-preview">
        <PlayerMock colors={theme.preview} image={theme.image} compact label={theme.name + " theme"} />
      </div>
      <div className="theme-meta">
        <div className="theme-head">
          <h3>{theme.name}</h3>
          <span className="swatch" style={{ background: theme.preview.accent }} />
        </div>
        <p>{theme.description}</p>
      </div>
    </div>
  );
}
