# Development workflow

All of Qobuzify was built against a live Qobuz over the Chrome DevTools Protocol. Because Qobuz is Electron, you can open a debug port and drive the running app: read its state, probe selectors, hot-load an extension, screenshot the result, and iterate, without reinstalling for every change. This is the loop.

## Open a debug port

Launch Qobuz with a remote debugging port:

```
Qobuz.exe --remote-debugging-port=9333
```

Then `http://localhost:9333/json` lists the page targets, each with a `webSocketDebuggerUrl`. Connect a CDP client to the app page's socket and you can run `Runtime.evaluate` against the renderer, take screenshots with `Page.captureScreenshot`, and reload with `Page.reload`.

A small Node script is all you need for this: a plain WebSocket-to-CDP client, nothing fancy. Node 18+ has a global `WebSocket` and `fetch`, so there are no dependencies.

## Probe the app

Before you can script something, you have to find it. Evaluate JavaScript in the page to dump state and test selectors:

```js
// what does the player state look like?
JSON.stringify(window.Qobuzify.getState().player, null, 2)

// does this selector find what I think?
document.querySelectorAll(".ListItem__player").length

// what's on the player bar right now?
document.querySelector(".player").outerHTML
```

This is how the DOM selectors and store shapes throughout the docs were found: dump, inspect, confirm, then write the extension against what's actually there. Every selector these docs cite (the store, the player controls, the playlist rows, the search results, the lyrics renderer) came from exactly this kind of probing.

## Hot-load an extension

Most extensions can be loaded live without reinstalling. Read the extension source, wrap it the way the runtime does, and call it with the live API:

```js
var src = /* contents of extensions/my-ext/index.js */;
window.__cleanup_myext && window.__cleanup_myext();          // undo a previous load
window.__cleanup_myext = new Function("Qobuzify", "vendor", src)(window.Qobuzify, "");
```

Edit, re-run, see the change. Keep the returned cleanup around so each reload tears down the last one; this is exactly why the cleanup contract matters.

The one exception is Qobuzify Lyrics. It can't hot-swap cleanly (its shim and the vendor renderer don't unwind), so test it with a full reload after baking.

## Screenshot to verify

Don't trust that it looks right, look. `Page.captureScreenshot` gives you the rendered result, which is the honest check for anything visual. Pair a hot-load with a screenshot to check a specific feature end to end.

## Bake for the real test

Hot-loading proves the logic, but the faithful test is the extension running the way a user gets it: injected into `app.html` at launch. So the final check is always a real install:

```
qobuzify install
```

That rebuilds the payload from every extension and theme, injects it, and relaunches. If it works after a clean install and reload, it works. Hot-loading can hide load-order and boot-timing issues that only appear when the runtime loads everything fresh; baking catches those.

## A note on the dev scaffolding

The recon, debug, and verify scripts used to build Qobuzify were local scaffolding: one-off probes against a running Qobuz, not a stable interface, so they aren't part of this repo. What's worth keeping is the loop itself, and you can reproduce all of it with any CDP client and the snippets above.
