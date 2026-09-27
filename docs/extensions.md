# The bundled extensions

Thirty-one extensions ship with Qobuzify. Each lives in `extensions/<id>/` and is toggled from the Marketplace. A fresh install turns on a curated few (Quality of Life, Simple Client, For You, Qobuzify Lyrics, Better Search) and leaves the rest for you to enable; installs from before this default flipped keep whatever they already had on. (A few are platform-scoped and inert elsewhere: bitperfect only does anything in the standalone wrapper, mobile-app only on a narrow screen.) This is what they do and, where it's interesting, how.

Reading these is also the fastest way to learn the API, since they exercise all of it against real problems. If you're going to write your own, skim [feat-artists](#feat-artists) and [ux-tweaks](#ux-tweaks) first; they're the smallest complete examples.

## Discovery and playback

### recommended (For You)
A personalized home page built entirely from your own Qobuz data (favorites and listening history) plus Qobuz's own catalog endpoints. No external service. It adds a "For You" tab as the first nav item, becomes the app's home (auto-opens on launch, and the logo opens it), and renders a full-page overlay: a rotating "Top pick" hero, then shelves that fill in as data arrives (In your rotation, New from artists you love, Because you like X, Artists you might like, Fresh for you). It also builds "Made for you" mixes (a Daily Mix and per-artist mixes) into real playlists on demand. The hero rotates each visit and remembers its last pick so it doesn't get stuck.

### better-search
Replaces Qobuz's weak native search with an instant, ranked, filterable full-page takeover. It hooks the real search box and, as you type, covers the content region so the native `/search` page never shows. Multi-word queries are scored per word with a full-phrase bonus; results you've heard before surface higher. Filters for quality, year, and sort; a Spotify-style "Top result" hero next to a Songs column, then card grids. Cover play buttons play the specific thing, including a specific track (not the album's track 1), which takes real work on a sealed player. Closing restores the route you were on.

### smart-playback (Smart Radio)
A real fix for Qobuz's weak autoplay. The queue lives in the sealed player module, so instead of swapping its picks, one click builds a genuinely related set from a seed artist (plus similar artists' top tracks, weighted to your favorites, deduped against recent plays), drops it into a fresh "Qobuzify Radio" playlist, and plays that through the app. The old radio playlist is deleted right after, so the library holds exactly one, and a fresh id each run sidesteps Qobuz's playlist-content cache.

Two ways in: the player-bar button seeds from what's playing, and right-clicking any track row starts a **song radio** seeded from that recording's credited performer, with the track you clicked playing first. Rows are resolved to a track id the same way multi-select does it (the dwp row's own DOM id, or the store's track dictionary for web-player rows that carry none). Where Copy & Share is enabled it owns the right-click and offers the action inside its menu instead, so the two never both open.

"Top tracks" comes from `artist/page`, the route Qobuz's own clients use for *Most listened to*. The older `artist/get&extra=tracks` is ordered by release, not plays, and repeats the newest record once per album variant, so radios built on it circled the same handful of new songs. The old call remains as a fallback.

### genre-filter
Finer genre browsing for Discover. Qobuz's genre chips are coarse (Pop and Rock share a chip), so this adds a "Genres" pill next to them that opens a picker built from Qobuz's own genre tree, sub-genres included. Picking one opens a scoped, Discover-style overlay of that exact genre: New Releases, Most Streamed, Press Awards, and Playlists, all through the app's own featured endpoints with the in-app token. Inert off the Discover page.

### find-available
When a track isn't streamable in your country, Qobuz greys the row out and dead-ends. This puts a small accent button on those dead rows that searches the catalog for the same song, keeps only versions that actually stream for you (a different release, a remaster, a non-region-locked upload), pushes karaoke and tribute knockoffs down the ranking, and plays the best match through the app's own controls. A greyed-out track in a playlist stops being a dead end.

## Library and playlists

### playlist-tools
Stats, Export, remove-duplicates, and Sort for your own playlists. A "Tools" button appears in the playlist header, but only on playlists you own. Stats and Export are read-only (top artists, decades, hi-res share; copy or download as Text / M3U / CSV / JSON). Duplicates edits the playlist after an inline confirm. Sort never touches the original, it builds a new sorted playlist and opens it.

### playlist-power
A "Sort" button on any playlist page, yours or not: view its tracks by Recently added, Title A-Z, Duration, or Default, and play any track from that order. Long playlists are react-virtualized, so reordering the on-page rows can't work; it re-queries the whole playlist and renders its own list instead, then plays a clicked row through the native controls. (It also contains a "playing from" context pill, shipped off because playlist-context owns that job.)

### playlist-context
Remembers where playback came from, even after shuffle. The sealed queue stores no reference to its source playlist, so this caches the track ids of every playlist and album you open and shows a "Playing from" chip in the player bar for whichever cached source the current track belongs to. Click it to jump there with the current track highlighted; right-click to remove that track from the playlist without disturbing playback. The cache persists, so a recent source is recognized again after a relaunch.

### bulk-actions
"Favourite all", "Add all to a playlist", and a shuffle-and-play button in any album or playlist header. All through the playlist/favorite write API (favorite-create takes a batch). The shuffle builds a shuffled copy playlist and plays only those tracks, keeping exactly one shuffle playlist around.

### multi-select
Shift-click a range or Ctrl/Cmd-click to toggle tracks on any desktop track list, then act on all of them from a floating bar: Play, add to the queue, add to a playlist, or favourite. Track ids are parsed off the rows' own DOM ids, no fragile title matching; Play builds a throwaway playlist and plays it (the same move Smart Radio uses), and Queue merges entries into the app's own play-queue state. Selection clears on route change and Esc.

### library-load
Loads your entire favorites library up front (paged 500 at a time, the app's own page size) and caches it, so even a 40k-track collection browses, searches, and marks instantly instead of trickling in as you scroll. The id set persists; full metadata persists in chunks when it fits and degrades to memory-only on huge libraries. It exposes a shared `Q.library` API that other extensions consume; Better Search's library surface rides on it.

### feat-artists
Qobuz only shows the main artist on a track row; anyone featured or collaborating is buried in the credits. This digs the featured names out of `track.performers`, which rides along in the standard `album/get` / `playlist/get` response (one fetch per page, cached per id, no special credits endpoint), and appends " feat. X, Y" inline. One of the smallest complete extensions, and a good template.

### quality-badges
Puts Qobuz's own Hi-Res Audio logo on hi-res tracks, reusing the app's bundled `hires.png` so it looks native. Only hi-res gets a badge; CD and lossy show nothing, which is the point: hi-res becomes easy to spot at a glance.

## Lyrics

### qobuzify-lyrics
Synced, word-by-word lyrics with a karaoke fill, an album-cover background, and auto-scroll, opened from a player-bar button. It renders through Lyra (our own renderer) behind a shim, and pulls lyrics through the qobuzify.app cache proxy, zero setup, no accounts or credentials. This is the largest extension by far and has its own subsystem, the cache-proxy server. See [lyrics-server.md](lyrics-server.md).

## Now playing and controls

### full-app-display
A fullscreen now-playing overlay: big cover art, title/artist/album over a blurred backdrop, a live seekable progress bar, and prev/play-pause/next. Everything drives the real player controls underneath, so the sealed audio engine is never touched directly. Toggle from the player bar or the F key.

### seek-controls
-10s / +10s skip buttons and an A-B loop in the player bar. Seeking a sealed JUCE engine has exactly one clean path, the app's own progress bar, and getting it right is subtle. See [player-control.md](player-control.md).

### keyboard-shortcuts
Play/pause, seek, next/prev, volume, mute, like, shuffle, repeat, fullscreen, and focus-search, from anywhere. Every action drives the player's own DOM controls or the store. A `?` overlay lists them. Keys are ignored while you're typing and left alone when a modifier is held.

### sleep-timer
Stop playback after a set time or at the end of the current track. A moon button opens the menu; while armed it shows a live countdown. On expiry it pauses by clicking the play/pause control, since there's no pause API.

### media-session
Lockscreen, notification, and Bluetooth/headset transport controls. Qobuz's web player never touches the W3C Media Session API, so the OS has nothing to show; this publishes the current track (title, artist, cover art) plus a live position for the OS scrubber, and routes play/pause/next/prev/seek from hardware keys and headset buttons back through the app's own controls. On Linux it feeds MPRIS through the wrapper's bridge, and in the Android app it drives a native media session through an injected bridge, sharing one copy of the transport logic.

### bitperfect
Bit-perfect output for the standalone wrapper, Linux only for now. Chromium resamples and mixes every stream, lossless but not bit-perfect, so this re-plays the exact FLAC bytes through a bundled player that holds exclusive access to the DAC at the track's native rate, while the muted web element keeps decoding so the clock, scrobbling, MediaSession, and auto-advance all still work. Inert outside the wrapper; the Windows bake already has native exclusive-mode audio through JUCE.

## Cleanup and quality-of-life

### simple-client
Strips the Magazine nav item and the editorial promo carousels for a lean, library-first client. A "Lean" control on the Discover page lets you check/uncheck each promo section live.

### content-filters
Hide the top-nav items you don't use. A funnel button opens a checklist; hidden items go away via a scoped CSS rule that's careful not to touch the brand logo.

### ux-tweaks (Quality of Life)
Four small annoyances fixed: double-click a track row to play it, the library opens on your last-used tab, your grid/list view choice sticks, and an optional switch to hide the Hi-Res badges. A good example of a small extension that adds a toggle to the Qobuzify settings panel.

### playlist-finder (Playlist Finder)
Answers two things the native library cannot: which playlists a song is already on, and which songs you have never filed anywhere. A **Playlists** chip on the library lists every favourite with its playlist membership as clickable tags (tag opens that playlist), plus an **In no playlist** filter and a title/artist search.

Qobuz has no track-to-playlists endpoint, so the index is built once by walking your own playlists (`playlist/get?extra=tracks`, four at a time) and cached behind a fingerprint of `id:tracks_count` per playlist. That fingerprint moves whenever any playlist gains or loses a track, which is exactly when the index is stale, and stays put on a rename or reorder, which is exactly when a rebuild would be waste. **Refresh** forces one.

Qobuzify's own generated playlists are excluded, by the ids the creating extensions already store (`mob:shuffle`, `mob:radio`, `smart:pid`, `ms:tmp`, `mix:<theme>`), with a name pattern as a fallback. Measured on a 512-track library: with "Shuffle · My Tracks" indexed the orphan count was **2**; excluding the generated ones it is **121**, which is the number the question was actually asking for. Favourites come from library-load's cache, and the list is rendered rather than filtered in place because the native library list is windowed.

### hires-filter (Hi-Res Filter)
A **Hi-Res** chip on the library that swaps the track list for just your 24-bit favourites, each row showing Qobuz's Hi-Res badge and its sample rate. Click a row to open its album, or hit play to start that track. 24-bit is the same line Qobuz's own Hi-Res Audio badge draws, so the chip and the badge can never disagree.

It renders its own list rather than filtering the real one, because both cheaper approaches were measured and ruled out. Hiding non-hi-res rows fails: the library list is **windowed** — scrolling a 512-track library to the bottom moves the rendered row count 21 → 18, it never grows. It is a custom `ui-scroll` list rather than ReactVirtualized, so the usual virtualisation check misses it and the idea looks viable until you try it. Filtering Qobuz's own fetch by wrapping `Q.api` fails too: `Q.api` is Qobuzify's helper and Qobuz's list does not use it — spying across a full navigate-away-and-back to the library captured zero calls. Reaching the real request would mean patching `window.fetch`, which puts us in the path of every request the app makes.

So it reads the data `library-load` has already cached (it stores `maximum_bit_depth` per track) and drives playback through the album page, the one path proven to work on the sealed player. Nothing touches Qobuz's data layer. Requires the Library cache extension; without it the panel says so instead of silently showing nothing. The chip is re-asserted on DOM mutations, since Qobuz re-renders the layout host and takes it with it.

### copy-share
Right-click a track to copy "Artist - Title" or a shareable `play.qobuz.com` link. Works on list rows and the player bar's current track. It owns the right-click on those rows, so when Smart Radio is also enabled its "Start song radio" action appears at the top of this menu rather than as a second competing one.

### block-trash
Two buttons: a ban icon on artist pages to block the artist, a trash icon on track rows and the player bar to bin a song. Anything blocked or trashed greys out everywhere and never plays, enforced in three layers: pulled from the upcoming queue, denied at the stream-URL layer, and skipped if it still becomes current. A shield in the player bar lists everything you've blocked so you can undo it. All state is local.

## Integrations and history

### discord-rpc
Discord Rich Presence for what you're playing, matching the original qobuz-rpc presence (cover, timestamps, a pause state). The renderer is sandboxed, so the actual Discord IPC runs in the main process (`runtime/rpc-main.js`) and this extension posts track changes to it over localhost. A toggle in Qobuzify settings enables and disables it.

### last-fm
Scrobbles what you play to Last.fm: Now Playing on track start, the scrobble at 50% or 4 minutes, whichever comes first (the Last.fm rule; seeks don't count, sub-30s tracks never scrobble). Signing happens on the qobuzify.app worker, so no API key or secret ships in the client and the extension holds only your session key. It can also bulk-import the history recorded by Listening Stats. Connect from the Qobuzify settings panel.

### stats (Listening Stats)
Private, on-device listening history. A 1-second tick logs each play you actually listened to (Last.fm-style threshold, seeks don't count) into a local IndexedDB and powers a stats.fm-style dashboard: top artists and songs, minutes, streaks, recently played, a minutes-per-day chart, ranges from 1D to All. Local-only by default; cloud sync exists but stays off until you explicitly turn it on.

## Platform

### mobile-app
On a narrow screen, replaces Qobuz's desktop-only web layout with a purpose-built mobile app: our own Home, Search, Library, and Now Playing, a bottom tab bar, and a mini player, rendered in a container the extension fully owns so nothing gets cut off. Qobuz stays mounted underneath as the engine only (auth, API, audio, and the album pages it navigates invisibly to start playback). Completely inert on desktop and wide windows.

"Play next" and "Add to queue" merge straight into the app's own play-queue state rather than driving the native kebab menu behind the overlay: the old path had to navigate to the album, scroll a virtualised list to the row, open its menu and find the entry, and any one of those four DOM contracts breaking made every queue attempt fail. The menu path is still the fallback for rows that carry only an album id. Artist "Top tracks" uses `artist/page` (Qobuz's *Most listened to*) instead of the release-ordered `artist/get&extra=tracks`, which returned the newest single repeated once per album variant.

## Defaults

Extensions ship off and you enable them from the Marketplace. The exceptions set `"defaultOn": true` in their manifest and are on out of the box: Quality of Life, Simple Client, For You, Qobuzify Lyrics, and Better Search. An install that predates this flip keeps whatever it already had on (a one-time migration pins the old set), so only fresh installs land on the curated defaults.
