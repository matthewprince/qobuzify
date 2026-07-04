# Writing a theme

A theme recolors the Qobuz UI. At its simplest it's a handful of CSS variables in a JSON file. At its fullest it also ships a CSS file that restyles real controls. A copy-paste starter lives in `templates/theme/`: [my-theme.json](templates/theme/my-theme.json) plus [my-theme.css](templates/theme/my-theme.css).

## The token system

Qobuz styles its modern UI with a named CSS-variable design-token system. A theme's `tokens` map overrides those variables, and the runtime injects them as a `:root { ...; !important }` block. The ones that matter most:

```
--color-brand-100         the accent (the gold, by default). This is the big one.
--color-brand-80          a lighter accent, for hovers and secondary highlights
--color-grey-120 .. -80   the surface ramp, darkest to lightest (backgrounds, panels, cards)
--color-opacity-accent-soft-10/20/30      translucent accent tints (subtle fills)
--color-opacity-accent-strong-25/30/40    stronger accent tints (borders, glows)
```

A minimal accent swap is just the brand token:

```json
{
  "name": "Electric Blue",
  "author": "you",
  "description": "Qobuz gold swapped for Electric Blue.",
  "preview": { "bg": "#121212", "surface": "#181818", "accent": "#3DA8FE", "text": "#f3f3f3" },
  "tokens": {
    "--color-brand-100": "#3DA8FE",
    "--color-brand-80": "#62B8FF",
    "--color-opacity-accent-soft-10": "#3DA8FE1a",
    "--color-opacity-accent-soft-20": "#3DA8FE26",
    "--color-opacity-accent-soft-30": "#3DA8FE33",
    "--color-opacity-accent-strong-25": "#3DA8FE40",
    "--color-opacity-accent-strong-30": "#3DA8FE4d",
    "--color-opacity-accent-strong-40": "#3DA8FE66"
  }
}
```

The `preview` object is the swatch the Marketplace draws (background, surface, accent, text). It's also where `--qz-accent` comes from: the runtime sets that variable to `preview.accent`, and every extension uses `var(--qz-accent)` for its own accent, so your theme automatically colors the Qobuzify UI too.

## Going full-depth

Here's the thing about Qobuz's controls: a lot of them are hardcoded white, not tied to the brand token. Recolor only `--color-brand-100` and you get a themed accent sitting in a still-white-and-grey app. A theme that actually feels like a theme recolors the real controls, the chrome, the panels, the list rows, the player, not just the brand variable.

That's what the optional `cssFile` is for. Point a theme at a companion CSS file and it's appended after the tokens:

```json
{
  "name": "Glass",
  "tokens": { "...": "..." },
  "cssFile": "glass.css"
}
```

`glass.css` then does the structural work: frosted translucent chrome, accent-tinted list rows, a transparent player bar, glow shadows. The bundled Glass, Neon, Matrix, Cosmic, Dramatic, and Terracotta themes all ship a CSS file; the plain accent-swaps (Electric Blue, Nord, Dracula, OLED Black) don't.

## Generating a theme

The bundled set was generated programmatically: take a design system's color ramp, map the neutral ramp onto Qobuz's grey tokens and the brand color onto the accent, then emit both the token map and Glass-level structural CSS with a per-theme effect mode (a glow, a hard neon, a soft glass). That's how one design system became several accented themes at once.

You don't need any of that to write a theme, though. Hand-writing the JSON is fine, and copying `glass.css` as a starting point for the structural layer is often faster. The generative approach only pays off when you're turning a whole design system into a consistent family in one go.

## Adding your theme

1. Drop `my-theme.json` (and optionally `my-theme.css`) in `themes/`.
2. Run `qobuzify install`. Your theme shows up in the Marketplace, switchable live.

Theme order in the Marketplace is set by the `ORDER` array in `lib/apply.js` (flagship themes first, then the rest alphabetically). Add your slug there if you want it in a particular spot; otherwise it sorts to the end.

## Tips

- Design against a dark base. Qobuz's UI is dark, and `--color-grey-120` is the darkest surface. Set your backgrounds from the grey ramp so contrast stays right.
- Keep the accent readable on both dark surfaces and white text. The accent lands on buttons (dark text on accent) and as text/borders (accent on dark), so it has to work both ways.
- Test the player bar and the context menus, not just the main content. Those are the surfaces most likely to stay stubbornly white if you only touched the brand token.
- Switch themes live from the Marketplace while you iterate. No reinstall needed to see a JSON change after a fresh `install`.

## Submitting it

Happy with it? Submit it at [qobuzify.app/submit](https://qobuzify.app/submit) with a link to the JSON (and CSS, if it has one). Approved themes ship in the bundled catalog so everyone can pick them from the Marketplace. Submissions are reviewed by hand before they ship.
