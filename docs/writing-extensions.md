# Writing an extension

An extension is a folder, a manifest, and one function. This walks through the lifecycle, the patterns you'll reuse, and the mistakes worth avoiding. A copy-paste starter lives in `templates/extension/`: [manifest.json](templates/extension/manifest.json) plus [index.js](templates/extension/index.js).

## The shape

```
extensions/my-extension/
  manifest.json
  index.js
```

`manifest.json`:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "description": "One sentence on what it does, shown in the Marketplace.",
  "icon": "icon-magic-stars",
  "version": "1.0.0",
  "author": "you",
  "defaultOff": false
}
```

`icon` is a Qobuz icon-font class (e.g. `icon-magic-stars`, `icon-heart`, `icon-users`). `defaultOff` is optional; set it to ship the extension disabled.

`index.js` is not a module. Its entire contents become the body of a function the runtime calls as `function (Qobuzify, vendor) { ... }`. It returns a cleanup function:

```js
var Q = Qobuzify;

Q.css("my-ext-css", ".my-badge { color: var(--qz-accent, #3DA8FE); }");

var off = Q.onRoute(function (path) {
  // do something on navigation
});

return function cleanup() {
  off();
  var st = document.getElementById("my-ext-css"); if (st) st.remove();
};
```

To load it, run `qobuzify install` (or `apply`). The installer bundles every `extensions/<id>/` into the payload and the runtime loads the enabled ones. During development you can hot-load a single extension over the debug port without reinstalling; see [dev-workflow.md](dev-workflow.md).

## Patterns

### Add a button to the player bar

```js
var btn = Q.el('<button class="qz-pbtn" title="Do the thing"><span class="icon-magic-stars"></span></button>');
btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); doThing(); });
var slot = Q.playerSlot({ id: "my-ext", zone: "right", order: 30, el: btn });
// cleanup: slot.remove();
```

`zone` is `"left"` (near the track info) or `"right"` (the settings cluster). The `qz-pbtn` class gives you a standard native-sized icon button that already tracks the theme accent on hover.

### React to the current song

```js
var off = Q.player.onChange(function (track) {
  if (!track) return;
  render(track);
});
```

For something that must never miss a change (a cover background), poll instead and dedupe:

```js
var last = null;
var iv = setInterval(function () {
  var t = Q.player.getTrack();
  var key = t ? t.id + "|" + t.cover : "";
  if (key !== last) { last = key; render(t); }
}, 250);
// cleanup: clearInterval(iv);
```

### Paint something onto the page, and keep it painted

Qobuz re-renders constantly. Use `observe` to re-apply your DOM changes, and make the work idempotent (a no-op when it's already done):

```js
function paint() {
  var rows = document.querySelectorAll(".ListItem");
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].querySelector("[data-my-badge]")) continue; // already done
    // ... add your badge, marked with data-my-badge ...
  }
}
var obs = Q.observe(paint, { debounce: 200 });
var offRoute = Q.onRoute(function () { setTimeout(paint, 300); });
```

quality-badges and feat-artists are the reference implementations of this pattern.

### A full-page overlay (the z-index rule)

This is the one to get right. A full-page overlay must sit above the content but below Qobuz's nav and player, or the account menu and context menus open behind it. Host it inside the layout, not on `document.body`:

```js
function layoutHost() {
  var pt = document.querySelector(".ui-layout--root--panel-top");
  return (pt && pt.parentElement) || document.body;
}

function open() {
  var page = document.createElement("div");
  page.id = "my-ext-page"; // CSS sets position:fixed; z-index:220; and fills the content rect
  layoutHost().appendChild(page);
}
```

Give it `z-index: 220` (above content at ~0, below the nav/player panels at 250). Re-append it on `observe` in case React reparents things. Never `display:none` a live overlay from a dev console during recon; it persists on the running app. See [gotchas.md](gotchas.md), both of these cost real time.

### Add a toggle to the Qobuzify settings panel

If your extension has an option, add a row to the settings panel instead of building your own settings UI:

```js
function injectToggle() {
  var panel = document.querySelector('.qz-panel[data-panel="settings"]');
  if (!panel || panel.querySelector("#my-ext-row")) return;
  var on = Q.storage.get("my-ext:opt", "0") === "1";
  var row = document.createElement("div");
  row.className = "qz-set-row"; row.id = "my-ext-row";
  row.innerHTML =
    '<div><div class="qz-set-label">My option</div>' +
    '<div class="qz-set-sub">What it does.</div></div>' +
    '<button class="qz-switch ' + (on ? "qz-switch--on" : "") + '" data-my="opt"><span></span></button>';
  panel.appendChild(row);
  row.querySelector("[data-my]").addEventListener("click", function () {
    var now = Q.storage.get("my-ext:opt", "0") !== "1";
    Q.storage.set("my-ext:opt", now ? "1" : "0");
    this.classList.toggle("qz-switch--on", now);
    apply();
  });
}
var obs = Q.observe(injectToggle, { debounce: 350 });
```

ux-tweaks does this for its "hide Hi-Res badges" switch.

### Persist a setting

```js
Q.storage.set("my-ext:count", "3");
var n = parseInt(Q.storage.get("my-ext:count", "0"), 10);
```

Keys are namespaced per extension, so you won't collide with anyone else. Values are strings; serialize structured data yourself.

### Call the Qobuz API

```js
Q.api("favorite/getUserFavorites?type=tracks&limit=200").then(function (j) {
  var tracks = (j.tracks && j.tracks.items) || [];
});
```

Guard everything and handle the empty case. These calls fail sometimes, and an unhandled rejection in an extension shouldn't take down the rest.

## The cleanup checklist

Your returned function has to undo everything the extension did, because it can be toggled off at runtime:

- Unsubscribe every `onRoute`, `observe`, `subscribe`, `player.onChange`
- `clearInterval` / `clearTimeout` any timers
- `slot.remove()` / `navItem.remove()` for anything you added through the API
- Remove every DOM node you injected (mark them with a `data-` attribute or a class so you can find them all)
- Remove your `<style>` (`document.getElementById("my-ext-css").remove()`)
- Remove document-level listeners you added directly

If toggling your extension off leaves anything behind, the cleanup is incomplete. Copy the cleanup from a bundled extension as a template.

## Defensive style

The DOM you're scripting against isn't yours and changes between Qobuz versions. A selector that returns nothing today might return something unexpected tomorrow. Wrap store reads in try/catch, null-check every `querySelector`, and make observers no-op when the thing they need isn't there. This isn't paranoia; it's what keeps one changed class name from crashing the whole extension.

## Testing

Build against a live Qobuz over the Chrome DevTools Protocol. Hot-load your extension, screenshot, inspect, iterate, then bake it into `app.html` for a faithful final test. The full loop is in [dev-workflow.md](dev-workflow.md).

## Submitting it

When it's ready, submit it at [qobuzify.app/submit](https://qobuzify.app/submit) with a link to the source. Approved extensions ship in the bundled catalog, so everyone gets them in the Marketplace. Every submission is reviewed by hand first, because an extension is arbitrary JavaScript running with full access inside Qobuz, so keep the source public until it's merged and don't obfuscate it.
