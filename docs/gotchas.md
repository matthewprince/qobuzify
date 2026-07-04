# Gotchas

Every one of these cost real time to find. They're collected here so they cost you minutes instead. Grouped by area.

## Playback

**The player is sealed.** No `<audio>`, no play/pause/seek/queue API. Drive the app's own DOM controls or reach a React component's props through the fiber. This is the root of most of the list below. See [player-control.md](player-control.md).

**Writing `input.value` on the progress bar freezes it.** The bar commits a seek on `mouseup`, not on value change. Setting `input.value` directly only sets the visual "seeked" preview, and with no `mouseup` to commit it, the bar sticks at that value. Never write the value; synthesize the `mousemove` + `mouseup` gesture instead.

**The store's `settings.volume` goes stale.** It stayed pinned at 100 while the rendered slider moved, so every step computed off 100 and could only ever reach ~94. Read the true volume from the slider's rendered fill width, not the store.

**There are many `aria-label="Play"` buttons in the DOM at once.** The For You page's cards stay mounted but hidden (its first "In your rotation" card is the track you were just playing), plus the player bar, your own buttons, and the previous page mid-transition. A broad selector clicks the wrong one and plays the wrong album. Scope to a *visible* button inside a `PageHeader`.

**Reuse a playlist id and you get its cached contents.** Qobuz caches playlist content by id, so a "shuffle" or "radio" that reuses one playlist serves stale tracks. Create a fresh playlist each run (and delete the old one after) to sidestep the cache.

## The Qobuz API

**An emoji in a `playlist/create` name saves an empty name.** Keep generated playlist names to plain text with a plain prefix (`"Shuffle · " + name`, not an emoji).

**`playlist/deleteTracks` wants `playlist_track_id`, not the track id.** Each entry in a playlist has its own `playlist_track_id`; that's what removal keys off. The plain track id won't work.

**`onChange` misses some in-album auto-advances.** For anything that must never miss a track change (a cover-art background), poll `getTrack()` on a cheap interval and dedupe by id instead of relying on `onChange`.

## The DOM and React

**It's a legacy `ReactDOM.render` build.** The fiber root is at `#root._reactRootContainer._internalRoot.current` and the DOM key is `__reactContainere$<id>` (note the extra "e"). Find the Redux store by walking the fiber for a `memoizedProps` value with both `getState` and `subscribe`.

**Re-inserting a hovered node resets its `:hover` and flashes.** The player re-renders often, and re-appending an in-place, currently-hovered button detaches and reattaches it, resetting `:hover` to a blue/white flash. Only (re)insert a slot when it's actually out of place. And anchor it after a *stable* node, not the time display, which React swaps every second.

**The player-bar track name links to `/album/`, not `/track/`.** Clicking a song title in the player opens its album, so the title anchor is an `a[href*="/album/"]`, and it comes before the real album link in the DOM. A naive `querySelector('a[href*="/album/"]')` in the player grabs the title and hands you the title text as the "album". Scope album and artist reads to the `.player__track-album` line. The artist link text can also carry a trailing " -" separator, so strip leading/trailing dash junk. (`Q.player.getTrack()` does both for you.)

**Selectors go stale between Qobuz versions.** The Magazine nav item was `a.NavItem[href]`; it's now `.ui-block-nav-item > a.ui-link` inside `.NavBar__items`. A dead selector silently matches nothing and the feature quietly stops working. When something you hide reappears, check the selector first. Using a `:has()` wrapper with the anchor and legacy selectors as fallbacks buys some version-resilience.

## Overlays and z-index

**Host full-page overlays inside the layout, not on `document.body`.** Qobuz's nav and player sit at `z: 250`. An overlay on `document.body` at a max z-index covers them, and then the account menu and context menus open *behind* the overlay and can't be clicked. Host the overlay inside `.ui-layout--root--panel-top`'s parent at `z: 220` (above content at ~0, below the panels at 250). See the z-index map in [architecture.md](architecture.md).

**Never `display:none` a live overlay during recon.** If you hide an element from a dev console to inspect around it, that change persists on the user's running app. This wiped the lyrics view out from under a live session once. Reload to undo, and prefer non-destructive inspection.

## CSS

**You must set the standard `scrollbar-color`, not just `::-webkit-scrollbar`.** Any element that uses the standard `scrollbar-width` property (Qobuz's containers do, and so do several Qobuzify surfaces) makes Chromium ignore `::-webkit-scrollbar` and fall back to the native white scrollbar. Set `scrollbar-color` (with `!important`) globally or the webkit rules are quietly overridden.

**Qobuz hardcodes many controls white, not to the brand token.** Recoloring only `--color-brand-100` leaves a themed accent in a white-and-grey app. A real theme restyles actual controls (chrome, list rows, the player) through a companion CSS file. See [themes.md](themes.md).

## Electron main process

**`backgroundThrottling` is read only at window creation.** Chromium pauses `requestAnimationFrame` in a backgrounded renderer, which froze and stuttered the lyrics view on alt-tab. `setBackgroundThrottling` at runtime does nothing, and command-line switches load too late (Chromium reads them at process startup, before the main bundle runs). The fix has to patch the `webPreferences` at window creation: patch the literal directly and wrap the `BrowserWindow` constructor as a fallback.

**Apple's `amp-api` validates the `Origin` header, and a renderer fetch can't set it.** So the lyric request 401s. Rewrite the header in the main process with an `onBeforeSendHeaders` listener. Qobuz registers its own listener and "last listener wins", so install an all-URLs listener (pass everything through untouched, stamp `Origin`/`Referer` only on `amp-api`) and re-add it on a short timer to win the race.

**A big vendor bundle can't be inlined into the payload.** The runtime is injected as one inline `<script>`, and a 1.3 MB bundle inside it breaks the inline payload. Ship large bundles as a sibling `vendor.js`, copied into `dist`, loaded with `<script src="/qobuzify-ext-<id>.js">`.

## Lyrics rendering

**Alt-tab forced a synchronous whole-document reflow.** On refocus, Chromium marks the whole document's layout dirty, and the lyrics animator's `getBoundingClientRect()` then forces a synchronous full-document reflow that blocks the frame (and could glitch the scroll to the top). `contain: layout` on the lyrics page and its scroll viewport keeps that expensive internal layout cached across the invalidation. Apply it to the page and viewport only, not per line (per-line `contain` forces a block formatting context per line and changes spacing).

**Qobuz seeks at whole-second granularity.** Both the engine and the position clock round to the nearest second. Lyric lines rarely start on a whole second, so a plain round lands before the line about half the time and the previous line highlights. When seeking to a lyric, round up to the next second, unless the line starts in the first 150 ms.

**Same-title songs match the wrong lyrics.** Two different songs called "Wolves" cross-matched, so an 83-second track served a 193-second song's lyrics. Guard with duration: if a cached lyric's timing overruns the track by more than 10 seconds, it's a wrong-song match. Evict and re-resolve. See [lyrics-server.md](lyrics-server.md).

## Development

**Qobuzify Lyrics can't hot-swap over the debug port.** Most extensions hot-load fine (inject the new source, no reload). The lyrics extension can't; it needs a full reload to re-run cleanly. See [dev-workflow.md](dev-workflow.md).
