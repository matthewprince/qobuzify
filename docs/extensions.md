# The bundled extensions

Eighteen extensions ship with Qobuzify. Each lives in `extensions/<id>/`, is on by default, and can be toggled from the Marketplace. This is what they do and, where it's interesting, how.

Reading these is also the fastest way to learn the API, since they exercise all of it against real problems. If you're going to write your own, skim [feat-artists](#feat-artists) and [ux-tweaks](#ux-tweaks) first; they're the smallest complete examples.

## Discovery and playback

### recommended (For You)
A personalized home page built entirely from your own Qobuz data (favorites and listening history) plus Qobuz's own catalog endpoints. No external service. It adds a "For You" tab as the first nav item, becomes the app's home (auto-opens on launch, and the logo opens it), and renders a full-page overlay: a rotating "Top pick" hero, then shelves that fill in as data arrives (In your rotation, New from artists you love, Because you like X, Artists you might like, Fresh for you). It also builds "Made for you" mixes (a Daily Mix and per-artist mixes) into real playlists on demand. The hero rotates each visit and remembers its last pick so it doesn't get stuck.

### better-search
Replaces Qobuz's weak native search with an instant, ranked, filterable full-page takeover. It hooks the real search box and, as you type, covers the content region so the native `/search` page never shows. Multi-word queries are scored per word with a full-phrase bonus; results you've heard before surface higher. Filters for quality, year, and sort; a Spotify-style "Top result" hero next to a Songs column, then card grids. Cover play buttons play the specific thing, including a specific track (not the album's track 1), which takes real work on a sealed player. Closing restores the route you were on.

### smart-playback (Smart Radio)
A real fix for Qobuz's weak autoplay. The queue lives in the sealed player module, so instead of swapping its picks, one click builds a genuinely related set from what's playing (the current artist plus similar artists' top tracks, weighted to your favorites, deduped against recent plays), drops it into a fresh "Qobuzify Radio" playlist, and plays that through the app. The old radio playlist is deleted right after, so the library holds exactly one, and a fresh id each run sidesteps Qobuz's playlist-content cache.

## Library and playlists

### playlist-tools
Stats, Export, remove-duplicates, and Sort for your own playlists. A "Tools" button appears in the playlist header, but only on playlists you own. Stats and Export are read-only (top artists, decades, hi-res share; copy or download as Text / M3U / CSV / JSON). Duplicates edits the playlist after an inline confirm. Sort never touches the original, it builds a new sorted playlist and opens it.

### bulk-actions
"Favourite all", "Add all to a playlist", and a shuffle-and-play button in any album or playlist header. All through the playlist/favorite write API (favorite-create takes a batch). The shuffle builds a shuffled copy playlist and plays only those tracks, keeping exactly one shuffle playlist around.

### feat-artists
Qobuz only shows the main artist on a track row; anyone featured or collaborating is buried in the credits. This digs the featured names out of `track.performers`, which rides along in the standard `album/get` / `playlist/get` response (one fetch per page, cached per id, no special credits endpoint), and appends " feat. X, Y" inline. One of the smallest complete extensions, and a good template.

### quality-badges
Puts Qobuz's own Hi-Res Audio logo on hi-res tracks, reusing the app's bundled `hires.png` so it looks native. Only hi-res gets a badge; CD and lossy show nothing, which is the point: hi-res becomes easy to spot at a glance.

## Lyrics

### qobuzify-lyrics
Synced, word-by-word lyrics with a karaoke fill, an album-cover background, and auto-scroll, opened from a player-bar button. It renders through Lyra (our own renderer) behind a shim, and pulls lyrics from open sources, or better ones if you've connected Spotify or Apple. This is the largest extension by far and has its own subsystem, the cache-proxy server. See [lyrics-server.md](lyrics-server.md).

## Now playing and controls

### full-app-display
A fullscreen now-playing overlay: big cover art, title/artist/album over a blurred backdrop, a live seekable progress bar, and prev/play-pause/next. Everything drives the real player controls underneath, so the sealed audio engine is never touched directly. Toggle from the player bar or the F key.

### seek-controls
-10s / +10s skip buttons and an A-B loop in the player bar. Seeking a sealed JUCE engine has exactly one clean path, the app's own progress bar, and getting it right is subtle. See [player-control.md](player-control.md).

### keyboard-shortcuts
Play/pause, seek, next/prev, volume, mute, like, shuffle, repeat, fullscreen, and focus-search, from anywhere. Every action drives the player's own DOM controls or the store. A `?` overlay lists them. Keys are ignored while you're typing and left alone when a modifier is held.

### sleep-timer
Stop playback after a set time or at the end of the current track. A moon button opens the menu; while armed it shows a live countdown. On expiry it pauses by clicking the play/pause control, since there's no pause API.

## Cleanup and quality-of-life

### simple-client
Strips the Magazine nav item and the editorial promo carousels for a lean, library-first client. A "Lean" control on the Discover page lets you check/uncheck each promo section live.

### content-filters
Hide the top-nav items you don't use. A funnel button opens a checklist; hidden items go away via a scoped CSS rule that's careful not to touch the brand logo.

### ux-tweaks (Quality of Life)
Four small annoyances fixed: double-click a track row to play it, the library opens on your last-used tab, your grid/list view choice sticks, and an optional switch to hide the Hi-Res badges. A good example of a small extension that adds a toggle to the Qobuzify settings panel.

### copy-share
Right-click a track to copy "Artist - Title" or a shareable `play.qobuz.com` link. Works on list rows and the player bar's current track.

### discord-rpc
Discord Rich Presence for what you're playing, matching the original qobuz-rpc presence (cover, timestamps, a pause state). The renderer is sandboxed, so the actual Discord IPC runs in the main process (`runtime/rpc-main.js`) and this extension posts track changes to it over localhost. A toggle in Qobuzify settings enables and disables it.

## Off-by-default

An extension can set `"defaultOff": true` in its manifest to ship disabled. None of the current bundle does, but the loader honors it: `defaultOff` extensions stay off until you turn them on in the Marketplace.
