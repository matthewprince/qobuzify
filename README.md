# Qobuzify

**Spicetify, but for Qobuz.** Theme and extend the Qobuz desktop app.

Qobuz ships as unpacked Electron with a wide-open CSP, so Qobuzify injects one inline `<script>` into `app.html` and works from inside the running app: a live theme engine, a Marketplace and Qobuzify menu in the account dropdown, and an extension loader. It's fully reversible, and it's zero-dependency Node.

## Install

```
git clone <repo> && cd qobuzify
npm link                 # or: node bin/qobuzify.js <command>
qobuzify install         # inject the runtime + Marketplace, relaunch Qobuz
```

Open Qobuz, click your avatar, and pick **Marketplace** to switch themes live and toggle extensions. Needs Node 16+ and the Qobuz desktop app. Windows only (macOS planned; Qobuz has no Linux desktop app).

## What you get

- **10 themes**, switchable live from the Marketplace, from a plain accent swap to full frosted-glass restyles.
- **18 extensions**, on by default and individually toggleable, including a full-page ranked search, a personalized For You home, synced word-by-word lyrics, Smart Radio, listening stats, playlist tools, bulk actions, a fullscreen now-playing view, seek and A-B loop controls, a sleep timer, keyboard shortcuts, and Discord Rich Presence.

## Commands

```
qobuzify detect           show the Qobuz install Qobuzify will patch
qobuzify list             list available themes
qobuzify install [theme]  install the in-app runtime + Marketplace
qobuzify apply <theme>    set a theme and relaunch
qobuzify restore          revert to the stock Qobuz UI
```

## Docs

Full documentation is in [docs/](docs/), with a rendered single-page version at [docs/site.html](docs/site.html) (build it with `node docs/build.js`).

- [Getting started](docs/getting-started.md) and [architecture](docs/architecture.md)
- [The `window.Qobuzify` API](docs/api.md) and [writing an extension](docs/writing-extensions.md)
- [Writing a theme](docs/themes.md)
- [Controlling the sealed player](docs/player-control.md) and the [gotchas compendium](docs/gotchas.md)

The one thing worth knowing up front: Qobuz's audio engine is sealed (native JUCE, no `<audio>`, no play/seek API), so everything that touches playback drives the app's own controls. That constraint shapes the whole project, and [docs/player-control.md](docs/player-control.md) is all about it.

## How it works, briefly

`install` injects an inline runtime into `app.html` (before `bundle.js`), resets `legacy.css` to stock, and patches the Electron main process for a couple of things the renderer can't do (a background-throttle fix, Discord IPC, an optional Apple Music header rewrite). The runtime finds the app's Redux store through the React fiber, exposes a small API over it, applies the active theme by swapping one `<style>` element, and loads the bundled extensions. Originals are backed up as `*.qobuzify-bak`; `restore` puts them back. See [docs/architecture.md](docs/architecture.md) for the whole picture.
