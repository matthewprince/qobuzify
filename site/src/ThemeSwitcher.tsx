import { useEffect, useRef, useState, type CSSProperties } from "react";
import { THEMES } from "./themes";
import PlayerMock, { type PlayerColors } from "./PlayerMock";

// The hero centerpiece: one player mock that recolors live as you click theme chips.
// Starts on stock Qobuz (the "before"), then auto-cycles through the themes until the
// visitor grabs it, proving the instant, no-relaunch theme switch instead of asserting
// it. Frozen static under prefers-reduced-motion.
type Chip = { name: string; colors: PlayerColors; image?: string };

const VANILLA: Chip = {
  name: "Qobuz",
  colors: { bg: "#0c0c0c", surface: "#1c1c1c", accent: "#e3a300", text: "#f4f4f4" },
};

const CHIPS: Chip[] = [
  VANILLA,
  ...THEMES.map((t) => ({ name: t.name, colors: t.preview, image: t.image })),
];

export default function ThemeSwitcher() {
  const [i, setI] = useState(1); // start on the first real theme so the payoff shows immediately
  const [locked, setLocked] = useState(false);
  const reduce = useRef(false);

  useEffect(() => {
    reduce.current =
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce.current) return;
    if (locked) return;
    const id = setInterval(() => setI((n) => (n + 1) % CHIPS.length), 2600);
    return () => clearInterval(id);
  }, [locked]);

  const pick = (n: number) => {
    setLocked(true);
    setI(n);
  };

  const active = CHIPS[i];
  return (
    <div className="switcher" onMouseEnter={() => setLocked(true)}>
      <div className="switcher-stage">
        <PlayerMock colors={active.colors} image={active.image} label={active.name + " theme preview"} />
      </div>
      <div className="chips" role="listbox" aria-label="Preview a theme">
        {CHIPS.map((c, n) => (
          <button
            key={c.name}
            className={"chip" + (n === i ? " on" : "")}
            style={{ "--chip": c.colors.accent } as CSSProperties}
            onClick={() => pick(n)}
            onFocus={() => pick(n)}
            role="option"
            aria-selected={n === i}
            title={c.name}
          >
            <span className="chip-dot" />
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}
