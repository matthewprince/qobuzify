# Work order: "Wrong lyrics? ↻ Refetch" button — visual UI wired to `/v1/refetch`

**Owner:** lyra · **Created:** 2026-07-23 · **The endpoint (`GET /v1/refetch`) is built + deployed by the other side — this is JUST the visual button + its wiring.**

## Goal
Add a small user-facing control in the lyrics view. When a user thinks a song's lyrics are wrong/mistimed, they press it; it calls `/v1/refetch`, which re-resolves the song from a DIFFERENT provider, and the lyrics swap in place.

## Endpoint contract (already built — just call it)
`GET https://api.qobuzify.app/v1/refetch?qz=1&name=<t>&artist=<a>&album=<al>&durationMs=<n>&isrc=<i>&feats=<f>`
- Same params the client already passes to `/v1/lyrics` (reuse the exact URL builder, just swap the path).
- Response: `{ ok, hasLyrics, source (codename), previousSource (codename), alternative (bool), lyrics, key }`.
  - `alternative:true` → a DIFFERENT provider was found; render `lyrics`.
  - `alternative:false` → no other version exists; the current one is the only option — toast that.
  - HTTP `429` → rate-limited; toast "Try again in a moment."

## Where the button goes
1. **Website (qobuzify.app):** on the public Lyrics page (whatever surface shows lyrics there). Placement + styling per the site's design system.
2. **Desktop client** (`extensions/qobuzify-lyrics/`): in the lyrics view chrome — a small icon button (↻ + "Wrong lyrics?") near the existing lyrics controls. On the desktop the renderer is Lyra; add the button to the surrounding ext UI, NOT inside Lyra's DOM.
3. **Android** (`extensions/mobile-app/`): in the Now-Playing lyrics panel, as an action affordance alongside the existing lyrics buttons.

## Behavior
- Press → disable/spinner the button → `fetch` the refetch URL for the CURRENT track → on `alternative:true` re-render lyrics (desktop/mobile: feed the returned `lyrics` object into the existing render path; site: same renderer the page uses) → re-enable.
- `alternative:false` → toast "That's the only version available."
- `429`/error → toast "Couldn't refetch, try again."
- Debounce: ignore repeat presses while one is in flight; the endpoint also has a per-song cooldown so don't hammer it.
- The button acts on the TRACK CURRENTLY SHOWN in the lyrics view (same track object the lyrics fetch used).

## Notes
- Keep it unobtrusive — a small icon, not a big banner. It's a "this looks wrong, get me another" escape hatch.
- No auth/key needed (endpoint is `qz=1` keyless like `/v1/lyrics`); it's rate-limited server-side.
- Do NOT show provider names (leak rule) — `source`/`previousSource` are already codenames; if you surface them at all, show the codename only.
