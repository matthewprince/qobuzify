# The `window.Qobuzify` API

Every extension is called with one argument, `Qobuzify`, the API object built by the runtime. By convention extensions alias it as `Q`:

```js
var Q = Qobuzify;
```

This is the whole surface. It is deliberately small: enough to read player and app state, call the Qobuz API, and add UI, without wrapping things you can already do with the DOM.

## State and the store

### `Q.store`
The raw Redux store, if you need it directly. Most of the time the helpers below are enough.

### `Q.getState()`
`store.getState()`. The useful slices:

- `state.player`: `{ playingState, position, currentTrack, quality, ... }`
- `state.router.location.pathname`: the current route
- `state.user.token`: the in-app Qobuz auth token (used by `Q.api`)
- `state.playqueue.history`: recently played track ids

### `Q.subscribe(fn)`
`store.subscribe(fn)`. Fires on every state change. Returns an unsubscribe function. Debounce it yourself if you only care about specific slices; it fires a lot.

```js
var off = Q.subscribe(function () { /* runs on every dispatch */ });
// later: off();
```

## Player

Reads only. There is no play / pause / seek here, because the audio engine is sealed. To control playback you drive the app's own controls; see [player-control.md](player-control.md).

### `Q.player.getTrack()`
The current track as a flat object, read from the store and the player-bar DOM:

```js
{
  id: 12345,
  title: "Song",
  artist: "Main Artist",       // first artist, convenience
  artists: ["Main Artist", "Feature"],
  album: "Album",
  albumId: "abc123",
  durationMs: 210000,
  cover: "https://.../cover_600.jpg",
  quality: "Hi-Res 24-Bit / 96 kHz"  // or null
}
```

Returns `null` if nothing is loaded.

### `Q.player.getPositionMs()`
Current playback position in milliseconds. Computed from the store's last known position plus the time elapsed since its timestamp (so it advances smoothly between store updates), clamped to the track duration.

### `Q.player.isPlaying()`
`true` when `playingState === "play"`.

### `Q.player.onChange(fn)`
Calls `fn(track)` whenever the current track id changes. Returns an unsubscribe function. This is the one to use for "do something when the song changes".

```js
var off = Q.player.onChange(function (track) {
  console.log("now playing", track.title);
});
```

Note: `onChange` is reliable for user-driven track changes but can miss some in-album auto-advances. If you need to be certain (a cover-art background, say), poll `getTrack()` on a cheap interval and dedupe by id. The lyrics extension does exactly that.

## The Qobuz API

### `Q.api(methodPath)`
Calls the Qobuz HTTP API with the in-app app id and your auth token, and returns the parsed JSON. Rejects on a non-OK response.

```js
Q.api("album/get?album_id=" + id).then(function (j) {
  var tracks = j.tracks.items;
});
```

These are all read endpoints and playlist/favorite writes that Qobuz itself exposes as GET requests. A few that come up:

```
album/get?album_id=
artist/get?artist_id=&extra=albums|tracks
artist/getSimilarArtists?artist_id=
catalog/search?query=&limit=
favorite/getUserFavorites?type=artists|albums|tracks
favorite/create?type=tracks&track_ids=a,b,c        (batch works)
playlist/get?playlist_id=&extra=tracks&limit=&offset=
playlist/create?name=&is_public=false
playlist/addTracks?playlist_id=&track_ids=
playlist/deleteTracks?playlist_id=&playlist_track_ids=
playlist/getUserPlaylists
user/get
```

Two things to know: an emoji in a `playlist/create` name makes Qobuz save an empty name (use a plain prefix), and playlist track removal keys off `playlist_track_id`, not the plain track id. More in [gotchas.md](gotchas.md).

## DOM helpers

### `Q.css(id, text)`
Creates or updates a `<style>` element with the given id and sets its text. Calling it again with the same id replaces the contents, so it doubles as your handle for live updates. Returns the element.

```js
Q.css("my-ext-css", ".my-thing { color: var(--qz-accent); }");
```

Remove it in cleanup: `document.getElementById("my-ext-css").remove()`.

### `Q.el(html)`
Builds a detached DOM node from an HTML string and returns the first element. Handy for building UI without `document.createElement` chains.

```js
var btn = Q.el('<button class="qz-pbtn">Hi</button>');
btn.addEventListener("click", ...);
```

### `Q.observe(fn, opts)`
A debounced `MutationObserver` over `document.body` (`childList`, `subtree`). Runs `fn` once immediately, then on DOM changes, coalesced to one call per `opts.debounce` milliseconds (default 120). Returns a function that disconnects it. This is how extensions re-apply themselves as React re-renders the page.

```js
var off = Q.observe(function () { paintBadges(); }, { debounce: 200 });
```

Keep `fn` cheap and idempotent. It runs a lot, and it should be a no-op when there is nothing to do.

### `Q.onRoute(fn)`
Registers `fn(path)` to run when the route changes. Returns an unregister function. Use it to tear down page-specific UI and set up the next page's.

```js
var off = Q.onRoute(function (path) {
  if (/^\/album\//.test(path)) { /* ... */ }
});
```

### `Q.navigate(path)`
Navigates the Qobuz router (a connected-react-router push), with an `<a>`-click fallback. Use this instead of `location.href` so you stay inside the SPA.

## Persistent storage

### `Q.storage.get(key, default)` / `Q.storage.set(key, value)`
String key/value storage backed by `localStorage`, namespaced under `qobuzify:x:<key>`. `get` returns `default` when the key is missing. Each key is its own `localStorage` entry, not a shared JSON blob, so different extensions can't clobber each other.

```js
Q.storage.set("mysetting", "1");
var on = Q.storage.get("mysetting", "0") === "1";
```

Values are strings. `JSON.stringify` / `JSON.parse` yourself for anything structured.

## Adding UI

### `Q.playerSlot({ id, zone, order, el })`
Registers a button in the player bar. Returns `{ remove }`. The runtime places your element, keeps it alive across React re-renders, and spaces it against other extensions' buttons.

- `id`: unique string
- `zone`: `"left"` (by the track info and heart, in the open space before the transport) or `"right"` (the settings cluster, with lyrics and fullscreen)
- `order`: number; lower sorts first within the zone
- `el`: your button element (use the `qz-pbtn` class for a standard native-sized icon button)

```js
var btn = Q.el('<button class="qz-pbtn" title="Do a thing"><span class="icon-magic-stars"></span></button>');
btn.addEventListener("click", doThing);
var slot = Q.playerSlot({ id: "my-ext", zone: "right", order: 30, el: btn });
// cleanup: slot.remove();
```

### `Q.addNavItem({ id, label, icon, onClick })`
Adds an item to the sidebar nav. Returns `{ remove }`. For a full-page feature you'd typically add the nav item and open your own overlay from `onClick`. (For a page that replaces the main content region, see the overlay + z-index pattern in [writing-extensions.md](writing-extensions.md).)

## Theming

### `Q.accent()`
The active theme's accent color (the `--qz-accent` CSS variable), trimmed. In CSS, just use the variable directly so your UI tracks theme changes automatically:

```css
.my-thing { color: var(--qz-accent, #3DA8FE); }
```

## Credentials (lyrics only)

`Q.spotify`, `Q.spotifyToken`, and `Q.apple` carry the optional local lyric-source credentials from the install payload, or `null`. Only the Qobuzify Lyrics extension uses these. They never leave the machine except to the source they authenticate.

## The cleanup contract

Your extension returns a function. The runtime calls it when the extension is toggled off. It has to undo everything:

```js
return function cleanup() {
  if (offRoute) offRoute();
  if (obs) obs();
  if (slot) slot.remove();
  document.querySelectorAll(".my-injected-node").forEach(function (n) { n.remove(); });
  var st = document.getElementById("my-ext-css"); if (st) st.remove();
};
```

If you skip this, turning the extension off leaves styles, nodes, and live listeners behind. Every bundled extension returns a real cleanup; copy one as a checklist.
