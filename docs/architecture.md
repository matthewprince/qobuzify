# Architecture

Qobuzify has four moving parts: the CLI that installs it, the inline runtime it injects, the extension loader inside that runtime, and the theme engine. This doc walks through each and how they connect.

## The shape of the target

The Qobuz desktop app is an unpacked Electron app. On Windows it lives at roughly:

```
%LOCALAPPDATA%\Programs\Qobuz\app-<version>\resources\dist\
```

Two things about it make Qobuzify possible:

1. **Nothing is packed or signed.** No `.asar`, no integrity check on the renderer, and the content security policy is wide open, so an inline `<script>` in `app.html` just runs.
2. **The UI is a normal React + Redux SPA.** Once you can reach the Redux store, you can read player state, dispatch router navigations, and observe everything the app does.

The one thing that is *not* reachable is the audio. Qobuz decodes and plays through a native JUCE addon (`juce.node`). There is no `<audio>` element and no play / pause / seek / queue function exposed to the renderer. Every playback feature in Qobuzify works around that, and [player-control.md](player-control.md) is entirely about how.

## 1. Install: what the CLI touches

The CLI (`bin/qobuzify.js`) calls `install()` in `lib/apply.js`. Install is idempotent and only ever touches three files, always rebuilding from a pristine backup so re-running stays clean.

**`app.html`** gets one inline script injected right before `bundle.js`:

```html
<script id="qobuzify-runtime">
  window.__QOBUZIFY__ = { catalog, extensions, def, version, seed, spotify, spotifyToken, apple };
  /* ...the entire runtime source... */
</script>
<script src="/bundle.js"></script>
```

The `window.__QOBUZIFY__` payload is the data the runtime reads at boot: the theme catalog, every extension's source, the default theme, and any local lyrics credentials. The runtime source is inlined right after it. The whole thing is escaped so a `</script>` inside any theme CSS or extension body can't break out of the tag.

**`legacy.css`** is reset to stock. Older Qobuz rules hardcode the brand gold as literal hex, and the original Qobuzify swapped those in the file. The live theme engine overrides design tokens at runtime instead, so the install just keeps `legacy.css` pristine.

**`main-win32.js`** (the minified main-process bundle) gets patched for things the renderer can't do on its own. These run in Electron's main process, where `require()` is available:

- **Background-throttle fix** (always). Chromium pauses `requestAnimationFrame` in a backgrounded renderer, which is what made the lyrics view freeze and stutter on alt-tab. The fix forces `backgroundThrottling: false` on the main window, both by patching the `webPreferences` literal directly and by wrapping the `BrowserWindow` constructor as a fallback for future builds. See [gotchas.md](gotchas.md) for why it has to be done at window creation.
- **Discord Rich Presence** (always). The main-process half of the Discord RPC lives here (`runtime/rpc-main.js`, appended). It owns the Discord IPC pipe and a localhost bridge the renderer posts track changes to. The renderer is sandboxed and can't do Discord IPC itself.
- **Apple Music header rewrite** (only if you've added Apple credentials). Apple's `amp-api` validates the `Origin` header and a renderer fetch can't set it, so lyric requests would 401. A main-process `onBeforeSendHeaders` listener stamps `Origin`/`Referer` on `amp-api.music.apple.com` requests.

Big prebuilt bundles (the Qz Lyrics renderer) ship as a sibling `vendor.js` and get copied into the `dist` directory so the extension can load them with `<script src="/qobuzify-ext-<id>.js">`. Inlining a 1.3 MB bundle into the payload would break it.

Originals are backed up once as `*.qobuzify-bak`. `restore` copies them back and relaunches. A Qobuz update installs a new `app-<version>` folder, so you re-run `apply` after updating.

Install and restore both relaunch Qobuz, because the renderer only reads its HTML at launch.

## 2. The runtime

`runtime/qobuzify-runtime.js` is an IIFE that guards against double-injection and then does four things.

**Finds the Redux store.** Qobuz ships a legacy `ReactDOM.render` build, so the fiber root is at `#root._reactRootContainer._internalRoot.current` and the DOM key is `__reactContainere$<id>` (note the extra "e"). `findStore()` walks the fiber tree from a few candidate entry points looking for a `memoizedProps` value that has both `getState` and `subscribe`. That store is the spine of the whole API.

**Builds the API.** `buildApi()` returns the `Q` object that becomes `window.Qobuzify`. It wraps the store (`getState`, `subscribe`), the Qobuz HTTP API (`api()`, using the in-app auth token), player reads (`player.getTrack`, `getPositionMs`, `isPlaying`, `onChange`), and DOM helpers (`css`, `el`, `observe`, `onRoute`, `navigate`, `addNavItem`, `playerSlot`, `storage`). The full surface is in [api.md](api.md).

**Loads extensions.** For each enabled extension it compiles the source with `new Function("Qobuzify", "vendor", source)` and calls it with `window.Qobuzify` and the extension's vendor string. The return value is treated as a cleanup function. Toggling an extension off in the Marketplace runs that cleanup. Extensions are on by default; `localStorage["qobuzify:ext:<id>"] === "0"` means off.

**Runs the theme engine and the UI.** It injects the Marketplace overlay and the two account-menu items (Marketplace, Qobuzify), and applies the active theme. A `MutationObserver` re-injects the menu items and player-bar slots whenever React re-renders the navbar, coalesced to one run per burst.

Because the navbar and player mount asynchronously, boot polls briefly (and observes) until they exist, then stops.

## 3. The extension model

An extension is a folder under `extensions/`:

```
extensions/my-extension/
  manifest.json   { id, name, description, icon, version, author, defaultOff? }
  index.js        the body of function(Qobuzify, vendor) { ... return cleanup }
  vendor.js       (optional) a big prebuilt bundle, loaded via <script src>
```

`index.js` is not a module. Its whole contents become the body of a function that receives `Qobuzify` (the API) and `vendor` (the vendor string, or `""`), and returns a cleanup function:

```js
var Q = Qobuzify;
Q.css("my-ext", ".foo{color:var(--qz-accent)}");
var off = Q.onRoute(function (path) { /* ... */ });

return function cleanup() {
  off();
  var st = document.getElementById("my-ext"); if (st) st.remove();
};
```

The cleanup contract matters. An extension can be toggled off at runtime, so it has to undo everything it did: remove its styles, DOM nodes, and event listeners, and unsubscribe from the store. If it doesn't, turning it off leaves ghosts behind. [writing-extensions.md](writing-extensions.md) covers the patterns.

## 4. The theme model

A theme is a JSON file in `themes/`, optionally with a companion CSS file:

```json
{
  "name": "Glass",
  "author": "matthewprince",
  "description": "Frosted chrome over deep navy.",
  "preview": { "bg": "#060A12", "surface": "#0b0f19", "accent": "#3DA8FE", "text": "#F0F6FC" },
  "tokens": { "--color-brand-100": "#3DA8FE", "--color-grey-120": "#060A12" },
  "cssFile": "glass.css"
}
```

`buildCatalog()` reads `name`, `author`, `description`, `preview`, `tokens`, and `cssFile`. The runtime turns `tokens` into a `:root { ...; !important }` block and appends the CSS file, then swaps that into a single `<style id="qobuzify-live">`. Switching themes rewrites that one element, so it is live with no relaunch.

`preview` is the little swatch the Marketplace draws for the theme. `--qz-accent` is set from `preview.accent` and is the variable every extension uses for its own accent color, so extensions automatically match the active theme.

(Some older theme files also carry a `legacyReplace` map from the pre-runtime model. The live engine ignores it; tokens and CSS do the recoloring now.)

See [themes.md](themes.md) for the token system and the generator.

## The layout z-index map

This is worth knowing before you build any full-page overlay, because getting it wrong makes the app's own menus unclickable. Qobuz's layout stacks like this:

```
base content        z: auto (~0)
panel-left / right   z: 230
panel-top (nav)      z: 250   <- contains the NavBar
panel-bottom (player) z: 250
NavBar                z: 999   (nested inside panel-top)
```

A full-page overlay has to sit above the content but below the nav and player, or the account menu and track context menus open behind it and can't be clicked. The rule: host the overlay *inside the layout* (as a sibling of the panels, at `.ui-layout--root--panel-top`'s parent) at `z: 220`. Do not park it on `document.body` at a max z-index. The For You page, the search takeover, and the stats page all follow this. See [gotchas.md](gotchas.md).
