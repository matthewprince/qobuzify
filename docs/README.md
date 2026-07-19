# Qobuzify docs

Qobuzify is Spicetify for the Qobuz desktop app. It themes the client and extends it with real features, all from inside the running app, without forking or rebuilding anything Qobuz ships.

It works because the Qobuz desktop app is unpacked Electron (Electron 32 / Chromium 128) with a wide-open content security policy. Qobuzify injects one inline `<script>` into the app's `app.html`. That script is the runtime: it finds the app's Redux store through React's fiber tree, exposes a small `window.Qobuzify` API over it, loads the bundled extensions, and runs a live theme engine. From there, everything is a userscript against a music player you don't control the source of.

The catch that shapes the whole project: **the audio engine is sealed.** Qobuz plays audio through a native JUCE module (`juce.node`), not an HTML `<audio>` element, and there is no reachable play / pause / seek / queue API in the renderer. So anything that touches playback has to drive the app's own DOM controls (click the real play button, fake a drag on the real progress bar) or go through the Redux store. That constraint is why several extensions look the way they do, and it comes up constantly below.

## Start here

- **[getting-started.md](getting-started.md)**: install, the CLI, requirements, how to undo it all
- **[architecture.md](architecture.md)**: how the injection, runtime, extension loader, and theme engine fit together

## Reference

- **[api.md](api.md)**: the `window.Qobuzify` API that extensions are written against
- **[extensions.md](extensions.md)**: what every bundled extension does and how
- **[player-control.md](player-control.md)**: how to drive a sealed player (seek, transport, volume) from injected JS
- **[gotchas.md](gotchas.md)**: the things that cost days, collected so they cost you minutes

## Building your own

- **[writing-extensions.md](writing-extensions.md)**: the extension authoring guide, with a template you can copy
- **[themes.md](themes.md)**: the theme token system and how to write or generate a theme

## Subsystems

- **[lyrics-server.md](lyrics-server.md)**: the lyrics cache-proxy (a Cloudflare Worker + D1 + R2) behind the Qobuzify Lyrics extension
- **[dev-workflow.md](dev-workflow.md)**: the Chrome DevTools Protocol loop used to build and verify all of this against a live Qobuz
- **[releasing.md](releasing.md)**: the per-platform release channels and versioning scheme (designed, not yet implemented)

## What ships

- A zero-dependency Node CLI (`bin/qobuzify.js`) that installs the runtime and swaps themes
- The runtime (`runtime/qobuzify-runtime.js`), injected into `app.html`
- 18 extensions under `extensions/`
- 10 themes under `themes/`
- A lyrics cache-proxy Worker under `server/`

There are two ways this reaches a machine, and they are different products:

- **The bake** patches a natively installed Qobuz desktop app in place (`bin/qobuzify.js`, `lib/apply.js`, `site/public/install.ps1`). Windows only, because that is where the unpacked-Electron app exists.
- **The desktop app** wraps `play.qobuz.com` in our own Electron shell (`wrapper/`) and ships the same runtime, extensions and themes on top. This is what covers Linux, where Qobuz has no desktop app to patch at all. Built for Linux (AppImage, deb), Windows (nsis, portable) and macOS (dmg, zip).

They share the runtime and every extension, but they install, update and version separately. See [releasing.md](releasing.md).
